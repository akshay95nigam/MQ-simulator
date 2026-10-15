package com.payments.healthdashboard.demo;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ThreadLocalRandom;

import com.payments.healthdashboard.demo.DemoCatalog.DemoService;
import com.payments.healthdashboard.demo.DemoCatalog.Effect;
import com.payments.healthdashboard.monitor.ServiceRegistry;

import org.springframework.boot.autoconfigure.condition.ConditionalOnBooleanProperty;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** Fake Spring Boot Actuator endpoints for the services in {@link DemoCatalog}. */
@RestController
@RequestMapping("/demo/{slug}/actuator")
@ConditionalOnBooleanProperty(name = "dashboard.demo.enabled", matchIfMissing = true)
public class DemoActuatorController {

	private final DemoCatalog catalog;

	public DemoActuatorController(DemoCatalog catalog) {
		this.catalog = catalog;
	}

	@GetMapping("/health")
	public ResponseEntity<Map<String, Object>> health(@PathVariable String slug) throws InterruptedException {
		DemoService svc = lookup(slug);
		Effect effect = respondAfterDelay(slug);
		Map<String, Object> components = new LinkedHashMap<>();
		for (String c : svc.components()) {
			components.put(c, DemoCatalog.componentBody(c, c.equals(effect.failComponent())));
		}
		return ResponseEntity.status(effect.down() ? 503 : 200)
			.body(Map.of("status", effect.down() ? "DOWN" : "UP", "components", components));
	}

	@GetMapping("/health/liveness")
	public Map<String, Object> liveness(@PathVariable String slug) throws InterruptedException {
		lookup(slug);
		respondAfterDelay(slug);
		return Map.of("status", "UP");
	}

	@GetMapping("/health/readiness")
	public ResponseEntity<Map<String, Object>> readiness(@PathVariable String slug) throws InterruptedException {
		lookup(slug);
		Effect effect = respondAfterDelay(slug);
		String status = effect.readiness() != null ? effect.readiness() : effect.down() ? "OUT_OF_SERVICE" : "UP";
		return ResponseEntity.status("UP".equals(status) ? 200 : 503).body(Map.of("status", status));
	}

	@GetMapping("/info")
	public Map<String, Object> info(@PathVariable String slug) throws InterruptedException {
		DemoService svc = lookup(slug);
		respondAfterDelay(slug);
		return Map.of(
				"build", Map.of("artifact", svc.slug(), "name", svc.slug(), "version", svc.version(), "time",
						"2026-09-28T14:12:03Z"),
				"git", Map.of("branch", "release/2026.10", "commit", Map.of("id", "a1b2c3d4e5f6")),
				"java", Map.of("version", "21.0.4"));
	}

	private DemoService lookup(String slug) {
		return catalog.find(slug).orElseThrow(ServiceRegistry.NotFoundException::new);
	}

	/** Small natural jitter; "slow" incidents push latency past the 1 s threshold. */
	private Effect respondAfterDelay(String slug) throws InterruptedException {
		Effect effect = catalog.activeEffect(slug);
		ThreadLocalRandom random = ThreadLocalRandom.current();
		Thread.sleep(effect.slow() ? 1400 + random.nextInt(600) : 20 + random.nextInt(120));
		return effect;
	}

}
