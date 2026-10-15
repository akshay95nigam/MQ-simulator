package com.payments.healthdashboard.demo;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import com.payments.healthdashboard.model.ServiceRequest;

import org.springframework.boot.autoconfigure.condition.ConditionalOnBooleanProperty;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;

/**
 * A sample payment pipeline served by {@link DemoActuatorController}, so the
 * dashboard can be tried without cluster access. Each service drifts through
 * scripted incidents on a six-minute loop.
 */
@Component
@ConditionalOnBooleanProperty(name = "dashboard.demo.enabled", matchIfMissing = true)
public class DemoCatalog {

	public record DemoService(String slug, String stage, List<String> components, String version) {
	}

	/** What an active incident does to a service. */
	public record Effect(boolean slow, String failComponent, boolean down, String readiness) {

		static final Effect NONE = new Effect(false, null, false, null);

	}

	private record Incident(String slug, int fromSec, int toSec, Effect effect) {
	}

	static final List<DemoService> SERVICES = List.of(
			new DemoService("mq-inbound-listener", "Intake", List.of("jms", "diskSpace", "ping"), "3.4.1"),
			new DemoService("message-validator", "Validation", List.of("diskSpace", "ping", "schemaRegistry"), "2.9.0"),
			new DemoService("payment-transformer", "Transformation", List.of("db", "diskSpace", "ping", "redis"), "5.1.3"),
			new DemoService("iso20022-mapper", "Transformation", List.of("diskSpace", "ping"), "1.12.0"),
			new DemoService("enrichment-service", "Enrichment", List.of("db", "diskSpace", "ping", "referenceDataApi"), "4.0.2"),
			new DemoService("routing-service", "Routing", List.of("db", "diskSpace", "ping"), "2.2.7"),
			new DemoService("client-delivery-service", "Delivery", List.of("jms", "diskSpace", "ping", "clientGateway"), "6.3.0"),
			new DemoService("ack-handler", "Acknowledgement", List.of("jms", "db", "diskSpace", "ping"), "1.8.4"));

	private static final int CYCLE_SEC = 360;

	private static final List<Incident> INCIDENTS = List.of(
			new Incident("enrichment-service", 40, 130, new Effect(true, null, false, null)),
			new Incident("client-delivery-service", 150, 220, new Effect(false, "clientGateway", true, null)),
			new Incident("payment-transformer", 250, 300, new Effect(false, "redis", false, null)),
			new Incident("ack-handler", 310, 340, new Effect(false, null, false, "OUT_OF_SERVICE")));

	private final Environment environment;

	public DemoCatalog(Environment environment) {
		this.environment = environment;
	}

	public Optional<DemoService> find(String slug) {
		return SERVICES.stream().filter((s) -> s.slug().equals(slug)).findFirst();
	}

	public Effect activeEffect(String slug) {
		long t = Instant.now().getEpochSecond() % CYCLE_SEC;
		return INCIDENTS.stream()
			.filter((i) -> i.slug().equals(slug) && t >= i.fromSec() && t < i.toSec())
			.map(Incident::effect)
			.findFirst()
			.orElse(Effect.NONE);
	}

	/** Service definitions pointing at this instance's own /demo endpoints. */
	public List<ServiceRequest> serviceRequests() {
		String port = environment.getProperty("local.server.port", environment.getProperty("server.port", "8080"));
		String base = "http://localhost:" + port + "/demo/";
		return SERVICES.stream()
			.map((s) -> new ServiceRequest(s.slug(), s.stage(), "demo", "payments-demo",
					"Demo service served by this app — replace with your real OpenShift routes.", base + s.slug(),
					"/actuator/health", "/actuator/info", "", true, 1000L, true, "", false))
			.toList();
	}

	static Map<String, Object> componentBody(String name, boolean failing) {
		String status = failing ? "DOWN" : "UP";
		return switch (name) {
			case "db" -> Map.of("status", status, "details", Map.of("database", "PostgreSQL", "validationQuery", "isValid()"));
			case "jms" -> Map.of("status", status, "details", Map.of("provider", "IBM MQ 9.3.4.0"));
			case "diskSpace" -> Map.of("status", status, "details",
					Map.of("total", 21474836480L, "free", 15032385536L, "threshold", 10485760L, "exists", true));
			case "redis" -> Map.of("status", status, "details", failing
					? Map.of("error", "RedisConnectionFailureException: Unable to connect to redis:6379")
					: Map.of("version", "7.2.4"));
			case "clientGateway" -> Map.of("status", status, "details", failing
					? Map.of("error", "Connect timed out to client SFTP gateway")
					: Map.of("endpoint", "sftp-gw.client.example:22"));
			default -> Map.of("status", status);
		};
	}

}
