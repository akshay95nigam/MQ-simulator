package com.payments.healthdashboard.monitor;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import com.payments.healthdashboard.config.DashboardProperties;
import com.payments.healthdashboard.config.DashboardProperties.ServiceDefinition;
import com.payments.healthdashboard.model.MonitoredService;
import com.payments.healthdashboard.model.ServiceRequest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.json.JsonMapper;

import org.springframework.stereotype.Component;

/**
 * The set of monitored services: those declared under {@code dashboard.services}
 * (read-only) merged with those added through the UI (persisted to a JSON file).
 */
@Component
public class ServiceRegistry {

	private static final Logger log = LoggerFactory.getLogger(ServiceRegistry.class);

	private static final String DEFAULT_HEALTH_PATH = "/actuator/health";

	private static final String DEFAULT_INFO_PATH = "/actuator/info";

	private final Path storeFile;

	private final JsonMapper jsonMapper;

	private final List<MonitoredService> configServices;

	private final Map<String, MonitoredService> uiServices = new LinkedHashMap<>();

	public ServiceRegistry(DashboardProperties properties, JsonMapper jsonMapper) {
		this.storeFile = properties.getStoreFile();
		this.jsonMapper = jsonMapper;
		this.configServices = properties.getServices().stream().map(ServiceRegistry::fromDefinition).toList();
		for (MonitoredService s : configServices) {
			String error = validate(s);
			if (error != null) {
				throw new IllegalStateException("Invalid dashboard.services entry '" + s.name() + "': " + error);
			}
		}
		load();
	}

	public synchronized List<MonitoredService> list() {
		List<MonitoredService> all = new ArrayList<>(configServices);
		all.addAll(uiServices.values());
		return all;
	}

	public synchronized Optional<MonitoredService> get(String id) {
		MonitoredService s = uiServices.get(id);
		if (s != null) {
			return Optional.of(s);
		}
		return configServices.stream().filter((c) -> c.id().equals(id)).findFirst();
	}

	public synchronized MonitoredService create(ServiceRequest request) {
		Instant now = Instant.now();
		MonitoredService s = fromRequest(UUID.randomUUID().toString(), request, null, now, now);
		requireValid(s);
		uiServices.put(s.id(), s);
		save();
		return s;
	}

	public synchronized MonitoredService update(String id, ServiceRequest request) {
		MonitoredService existing = uiServices.get(id);
		if (existing == null) {
			throw configServices.stream().anyMatch((c) -> c.id().equals(id)) ? new ConfigManagedException()
					: new NotFoundException();
		}
		MonitoredService s = fromRequest(id, request, existing, existing.createdAt(), Instant.now());
		requireValid(s);
		uiServices.put(id, s);
		save();
		return s;
	}

	public synchronized void delete(String id) {
		if (uiServices.remove(id) == null) {
			throw configServices.stream().anyMatch((c) -> c.id().equals(id)) ? new ConfigManagedException()
					: new NotFoundException();
		}
		save();
	}

	/** Adds services whose base URL isn't already monitored; returns how many were added. */
	public synchronized int addIfAbsent(List<ServiceRequest> requests) {
		int added = 0;
		for (ServiceRequest r : requests) {
			boolean exists = list().stream().anyMatch((s) -> s.baseUrl().equals(trimUrl(r.baseUrl())));
			if (!exists) {
				Instant now = Instant.now();
				MonitoredService s = fromRequest(UUID.randomUUID().toString(), r, null, now, now);
				requireValid(s);
				uiServices.put(s.id(), s);
				added++;
			}
		}
		if (added > 0) {
			save();
		}
		return added;
	}

	// ---------- Mapping & validation ----------

	private static MonitoredService fromDefinition(ServiceDefinition d) {
		String name = text(d.getName());
		String id = "config-" + slug(name + "-" + text(d.getNamespace()) + "-" + text(d.getEnvironment()));
		return new MonitoredService(id, name, text(d.getStage()), text(d.getEnvironment()), text(d.getNamespace()),
				text(d.getDescription()), trimUrl(d.getBaseUrl()), orDefault(d.getHealthPath(), DEFAULT_HEALTH_PATH),
				text(d.getInfoPath()), text(d.getConsoleUrl()), d.isCheckProbes(), positive(d.getSlowThresholdMs()),
				d.isEnabled(), text(d.getAuthToken()), MonitoredService.SOURCE_CONFIG, null, null);
	}

	private static MonitoredService fromRequest(String id, ServiceRequest r, MonitoredService existing,
			Instant createdAt, Instant updatedAt) {
		// A blank token on edit keeps the stored one unless explicitly cleared.
		String token;
		if (r.authToken() != null && !r.authToken().isEmpty()) {
			token = r.authToken();
		}
		else if (Boolean.TRUE.equals(r.clearAuthToken()) || existing == null) {
			token = "";
		}
		else {
			token = existing.authToken();
		}
		return new MonitoredService(id, text(r.name()), text(r.stage()), text(r.environment()), text(r.namespace()),
				text(r.description()), trimUrl(r.baseUrl()), orDefault(r.healthPath(), DEFAULT_HEALTH_PATH),
				r.infoPath() == null ? DEFAULT_INFO_PATH : r.infoPath().trim(), text(r.consoleUrl()),
				r.checkProbes() == null || r.checkProbes(),
				positive(r.slowThresholdMs() == null ? 0 : r.slowThresholdMs()),
				r.enabled() == null || r.enabled(), token, MonitoredService.SOURCE_UI, createdAt, updatedAt);
	}

	static String validate(MonitoredService s) {
		if (s.name().isEmpty()) {
			return "Name is required.";
		}
		String url = s.baseUrl().toLowerCase(Locale.ROOT);
		if (!url.startsWith("http://") && !url.startsWith("https://")) {
			return "Base URL must start with http:// or https://";
		}
		if (!s.healthPath().startsWith("/")) {
			return "Health path must start with /";
		}
		if (!s.infoPath().isEmpty() && !s.infoPath().startsWith("/")) {
			return "Info path must start with /";
		}
		return null;
	}

	private static void requireValid(MonitoredService s) {
		String error = validate(s);
		if (error != null) {
			throw new IllegalArgumentException(error);
		}
	}

	private static String text(String value) {
		return value == null ? "" : value.trim();
	}

	private static String orDefault(String value, String fallback) {
		String t = text(value);
		return t.isEmpty() ? fallback : t;
	}

	private static String trimUrl(String url) {
		return text(url).replaceAll("/+$", "");
	}

	private static long positive(long value) {
		return value > 0 ? value : 1000;
	}

	private static String slug(String value) {
		return value.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]+", "-").replaceAll("(^-|-$)", "");
	}

	// ---------- Persistence ----------

	private void load() {
		if (!Files.exists(storeFile)) {
			return;
		}
		try {
			List<MonitoredService> stored = jsonMapper.readValue(storeFile.toFile(), new TypeReference<>() { });
			stored.stream()
				.sorted(Comparator.comparing(MonitoredService::createdAt, Comparator.nullsLast(Comparator.naturalOrder())))
				.forEach((s) -> uiServices.put(s.id(), s));
			log.info("Loaded {} service(s) from {}", uiServices.size(), storeFile);
		}
		catch (Exception ex) {
			throw new IllegalStateException("Service store " + storeFile + " is unreadable: " + ex.getMessage(), ex);
		}
	}

	private void save() {
		try {
			Path dir = storeFile.toAbsolutePath().getParent();
			Files.createDirectories(dir);
			Path tmp = Files.createTempFile(dir, "services", ".json");
			jsonMapper.writerWithDefaultPrettyPrinter().writeValue(tmp.toFile(), new ArrayList<>(uiServices.values()));
			Files.move(tmp, storeFile, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
		}
		catch (IOException ex) {
			throw new IllegalStateException("Could not write " + storeFile + ": " + ex.getMessage(), ex);
		}
	}

	/** No service with the given id. */
	public static class NotFoundException extends RuntimeException {

		public NotFoundException() {
			super("Not found");
		}

	}

	/** The service is declared in configuration and can't be changed through the API. */
	public static class ConfigManagedException extends RuntimeException {

		public ConfigManagedException() {
			super("This service is defined in the dashboard configuration (dashboard.services); change it there.");
		}

	}

}
