package com.payments.healthdashboard.monitor;

import java.time.Instant;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicBoolean;

import com.payments.healthdashboard.config.DashboardProperties;
import com.payments.healthdashboard.model.CheckResult;
import com.payments.healthdashboard.model.DashboardSnapshot;
import com.payments.healthdashboard.model.MonitoredService;
import com.payments.healthdashboard.model.ServiceHealth;
import com.payments.healthdashboard.model.ServiceHealth.HistoryPoint;
import com.payments.healthdashboard.model.ServiceView;
import com.payments.healthdashboard.model.Status;
import com.payments.healthdashboard.model.StatusEvent;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.MultiGauge;
import io.micrometer.core.instrument.Tags;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.scheduling.TaskScheduler;
import org.springframework.stereotype.Service;

/**
 * Polls every enabled service on a fixed delay, keeps the latest result,
 * a rolling history and a log of status changes, and publishes per-service
 * gauges for Prometheus / OpenShift monitoring.
 * <p>
 * State is in memory and rebuilds within one poll interval after a restart.
 */
@Service
public class HealthMonitor {

	private static final Logger log = LoggerFactory.getLogger(HealthMonitor.class);

	private final ServiceRegistry registry;

	private final HealthChecker checker;

	private final DashboardProperties properties;

	private final TaskScheduler scheduler;

	private final Map<String, ServiceHealth> results = new ConcurrentHashMap<>();

	private final Deque<StatusEvent> events = new ArrayDeque<>();

	private final AtomicBoolean running = new AtomicBoolean();

	private final ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor();

	private final MultiGauge upGauge;

	private final MultiGauge degradedGauge;

	private final MultiGauge latencyGauge;

	private volatile Instant lastRunAt;

	public HealthMonitor(ServiceRegistry registry, HealthChecker checker, DashboardProperties properties,
			TaskScheduler scheduler, MeterRegistry meterRegistry) {
		this.registry = registry;
		this.checker = checker;
		this.properties = properties;
		this.scheduler = scheduler;
		this.upGauge = MultiGauge.builder("payment.service.up")
			.description("1 when the service is up or degraded, 0 when down")
			.register(meterRegistry);
		this.degradedGauge = MultiGauge.builder("payment.service.degraded")
			.description("1 when the service is up but degraded (slow, or a component/probe not UP)")
			.register(meterRegistry);
		this.latencyGauge = MultiGauge.builder("payment.service.health.latency")
			.description("Response time of the latest actuator health call")
			.baseUnit("milliseconds")
			.register(meterRegistry);
	}

	@EventListener(ApplicationReadyEvent.class)
	public void start() {
		scheduler.scheduleWithFixedDelay(this::checkAllSafely, properties.getPollInterval());
		log.info("Polling services every {}", properties.getPollInterval());
	}

	private void checkAllSafely() {
		try {
			checkAll();
		}
		catch (RuntimeException ex) {
			log.error("Health check run failed", ex);
		}
	}

	/** Checks every enabled service concurrently. Returns immediately if a run is already in progress. */
	public void checkAll() {
		if (!running.compareAndSet(false, true)) {
			return;
		}
		try {
			List<Future<?>> futures = new ArrayList<>();
			for (MonitoredService svc : registry.list()) {
				if (svc.enabled()) {
					futures.add(executor.submit(() -> record(svc, checker.check(svc))));
				}
			}
			for (Future<?> f : futures) {
				try {
					f.get();
				}
				catch (InterruptedException ex) {
					Thread.currentThread().interrupt();
					return;
				}
				catch (Exception ex) {
					log.warn("Health check failed", ex);
				}
			}
			lastRunAt = Instant.now();
			publishMetrics();
		}
		finally {
			running.set(false);
		}
	}

	public Optional<ServiceHealth> checkOne(String id) {
		return registry.get(id).map((svc) -> {
			record(svc, checker.check(svc));
			publishMetrics();
			return results.get(id);
		});
	}

	/** Checks a service in the background, e.g. right after it was added or edited. */
	public void checkSoon(String id) {
		executor.submit(() -> checkOne(id));
	}

	public void forget(String id) {
		results.remove(id);
		publishMetrics();
	}

	public DashboardSnapshot snapshot() {
		List<DashboardSnapshot.Entry> entries = registry.list()
			.stream()
			.map((s) -> new DashboardSnapshot.Entry(ServiceView.of(s), results.get(s.id())))
			.toList();
		List<StatusEvent> recent;
		synchronized (events) {
			recent = events.stream().limit(50).toList();
		}
		return new DashboardSnapshot(properties.getPollInterval().toMillis(), properties.getTimeout().toMillis(),
				lastRunAt, properties.getDemo().isEnabled(), entries, recent);
	}

	private void record(MonitoredService svc, CheckResult result) {
		results.compute(svc.id(), (id, prev) -> {
			List<HistoryPoint> history = new ArrayList<>();
			if (prev != null) {
				List<HistoryPoint> old = prev.history();
				history.addAll(old.subList(Math.max(0, old.size() - (properties.getHistoryLength() - 1)), old.size()));
			}
			history.add(new HistoryPoint(result.checkedAt(), result.status(), result.latencyMs()));

			Instant since = result.checkedAt();
			if (prev != null && prev.status() == result.status()) {
				since = prev.since();
			}
			else if (prev != null) {
				String detail = result.error() != null ? result.error()
						: result.reasons().isEmpty() ? null : result.reasons().get(0);
				addEvent(new StatusEvent(result.checkedAt(), svc.id(), svc.name(), prev.status(), result.status(), detail));
			}
			return ServiceHealth.of(result, since, List.copyOf(history));
		});
	}

	private void addEvent(StatusEvent event) {
		log.info("{}: {} -> {}{}", event.serviceName(), event.from(), event.to(),
				event.detail() != null ? " (" + event.detail() + ")" : "");
		synchronized (events) {
			events.addFirst(event);
			while (events.size() > properties.getMaxEvents()) {
				events.removeLast();
			}
		}
	}

	private void publishMetrics() {
		List<MultiGauge.Row<?>> up = new ArrayList<>();
		List<MultiGauge.Row<?>> degraded = new ArrayList<>();
		List<MultiGauge.Row<?>> latency = new ArrayList<>();
		for (MonitoredService svc : registry.list()) {
			ServiceHealth h = results.get(svc.id());
			if (h == null || !svc.enabled() || h.status() == Status.UNKNOWN) {
				continue;
			}
			Tags tags = Tags.of("service", svc.name(), "stage", svc.stage(), "namespace", svc.namespace(),
					"environment", svc.environment());
			up.add(MultiGauge.Row.of(tags, h.status() == Status.DOWN ? 0 : 1));
			degraded.add(MultiGauge.Row.of(tags, h.status() == Status.DEGRADED ? 1 : 0));
			if (h.latencyMs() != null) {
				latency.add(MultiGauge.Row.of(tags, h.latencyMs()));
			}
		}
		upGauge.register(up, true);
		degradedGauge.register(degraded, true);
		latencyGauge.register(latency, true);
	}

}
