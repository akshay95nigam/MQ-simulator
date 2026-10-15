package com.payments.healthdashboard.monitor;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import com.payments.healthdashboard.config.DashboardProperties;
import com.payments.healthdashboard.model.CheckResult;
import com.payments.healthdashboard.model.MonitoredService;
import com.payments.healthdashboard.model.Status;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

import org.springframework.boot.ssl.DefaultSslBundleRegistry;

import static org.assertj.core.api.Assertions.assertThat;

class HealthCheckerTests {

	private record Stub(int status, String body, long delayMs) {
	}

	private final Map<String, Stub> stubs = new ConcurrentHashMap<>();

	private final Map<String, String> authHeaders = new ConcurrentHashMap<>();

	private HttpServer server;

	private HealthChecker checker;

	@BeforeEach
	void setUp() throws IOException {
		server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
		server.createContext("/", (exchange) -> {
			String path = exchange.getRequestURI().getPath();
			String auth = exchange.getRequestHeaders().getFirst("Authorization");
			if (auth != null) {
				authHeaders.put(path, auth);
			}
			Stub stub = stubs.getOrDefault(path, new Stub(404, "", 0));
			try {
				Thread.sleep(stub.delayMs());
			}
			catch (InterruptedException ex) {
				Thread.currentThread().interrupt();
			}
			byte[] bytes = stub.body().getBytes(StandardCharsets.UTF_8);
			exchange.sendResponseHeaders(stub.status(), bytes.length == 0 ? -1 : bytes.length);
			try (OutputStream out = exchange.getResponseBody()) {
				out.write(bytes);
			}
		});
		server.start();
		DashboardProperties properties = new DashboardProperties();
		properties.setTimeout(java.time.Duration.ofSeconds(2));
		checker = new HealthChecker(
				new ActuatorClient(properties, new DefaultSslBundleRegistry(), JsonMapper.builder().build()));
	}

	@AfterEach
	void tearDown() {
		server.stop(0);
	}

	private MonitoredService service(String token, long slowThresholdMs) {
		return new MonitoredService("id", "payment-transformer", "Transformation", "prod", "payments-prod", "",
				"http://127.0.0.1:" + server.getAddress().getPort(), "/actuator/health", "/actuator/info", "", true,
				slowThresholdMs, true, token, MonitoredService.SOURCE_UI, Instant.now(), Instant.now());
	}

	private void stub(String path, int status, String body) {
		stubs.put(path, new Stub(status, body, 0));
	}

	private void healthyProbes() {
		stub("/actuator/health/liveness", 200, "{\"status\":\"UP\"}");
		stub("/actuator/health/readiness", 200, "{\"status\":\"UP\"}");
	}

	@Test
	void upWhenEverythingIsUp() {
		stub("/actuator/health", 200, """
				{"status":"UP","components":{"db":{"status":"UP","details":{"database":"PostgreSQL"}},"jms":{"status":"UP"}}}""");
		healthyProbes();
		stub("/actuator/info", 200, """
				{"build":{"version":"5.1.3","artifact":"payment-transformer"},"git":{"branch":"main","commit":{"id":"a1b2c3d4e5f6"}}}""");

		CheckResult r = checker.check(service("", 1000));

		assertThat(r.status()).isEqualTo(Status.UP);
		assertThat(r.springStatus()).isEqualTo("UP");
		assertThat(r.components()).extracting(CheckResult.Component::name).containsExactly("db", "jms");
		assertThat(r.probes()).isEqualTo(new CheckResult.Probes("UP", "UP"));
		assertThat(r.info().version()).isEqualTo("5.1.3");
		assertThat(r.info().commit()).isEqualTo("a1b2c3d");
		assertThat(r.reasons()).isEmpty();
	}

	@Test
	void degradedWhenAComponentIsNotUp() {
		stub("/actuator/health", 200, """
				{"status":"UP","components":{"db":{"status":"UP"},"referenceData":{"status":"UNKNOWN"}}}""");
		healthyProbes();

		CheckResult r = checker.check(service("", 1000));

		assertThat(r.status()).isEqualTo(Status.DEGRADED);
		assertThat(r.reasons()).containsExactly("Components not UP: referenceData (UNKNOWN)");
	}

	@Test
	void degradedWhenReadinessIsOutOfService() {
		stub("/actuator/health", 200, "{\"status\":\"UP\"}");
		stub("/actuator/health/liveness", 200, "{\"status\":\"UP\"}");
		stub("/actuator/health/readiness", 503, "{\"status\":\"OUT_OF_SERVICE\"}");

		CheckResult r = checker.check(service("", 1000));

		assertThat(r.status()).isEqualTo(Status.DEGRADED);
		assertThat(r.reasons()).singleElement().asString().contains("Readiness is OUT_OF_SERVICE");
	}

	@Test
	void degradedWhenSlow() {
		stubs.put("/actuator/health", new Stub(200, "{\"status\":\"UP\"}", 120));
		healthyProbes();

		CheckResult r = checker.check(service("", 50));

		assertThat(r.status()).isEqualTo(Status.DEGRADED);
		assertThat(r.reasons()).singleElement().asString().startsWith("Slow response");
	}

	@Test
	void probesThatAreNotExposedDoNotDegrade() {
		stub("/actuator/health", 200, "{\"status\":\"UP\"}");

		CheckResult r = checker.check(service("", 1000));

		assertThat(r.status()).isEqualTo(Status.UP);
		assertThat(r.probes()).isEqualTo(new CheckResult.Probes("NOT_EXPOSED", "NOT_EXPOSED"));
		assertThat(r.info()).isNull();
	}

	@Test
	void downNamesTheFailingNestedComponent() {
		stub("/actuator/health", 503, """
				{"status":"DOWN","components":{"db":{"status":"DOWN","components":{"primary":{"status":"UP"},"reporting":{"status":"DOWN"}}},"ping":{"status":"UP"}}}""");
		healthyProbes();

		CheckResult r = checker.check(service("", 1000));

		assertThat(r.status()).isEqualTo(Status.DOWN);
		assertThat(r.httpStatus()).isEqualTo(503);
		assertThat(r.components()).extracting(CheckResult.Component::name)
			.containsExactly("db.primary", "db.reporting", "ping");
		assertThat(r.reasons()).containsExactly("Failing: db.reporting");
	}

	@Test
	void downWhenRouteHasNoPods() {
		stub("/actuator/health", 503, "<html>Application is not available</html>");

		CheckResult r = checker.check(service("", 1000));

		assertThat(r.status()).isEqualTo(Status.DOWN);
		assertThat(r.error()).contains("no ready pods");
	}

	@Test
	void downWithAuthHintOn401() {
		stub("/actuator/health", 401, "");

		CheckResult r = checker.check(service("", 1000));

		assertThat(r.status()).isEqualTo(Status.DOWN);
		assertThat(r.error()).contains("requires auth");
	}

	@Test
	void sendsBearerTokenToEveryEndpoint() {
		stub("/actuator/health", 200, "{\"status\":\"UP\"}");
		healthyProbes();
		stub("/actuator/info", 200, "{}");

		checker.check(service("s3cret", 1000));

		assertThat(authHeaders).containsOnlyKeys("/actuator/health", "/actuator/health/liveness",
				"/actuator/health/readiness", "/actuator/info");
		assertThat(authHeaders.values()).containsOnly("Bearer s3cret");
	}

	@Test
	void downWithHintWhenConnectionRefused() throws IOException {
		int closedPort;
		try (ServerSocket socket = new ServerSocket(0)) {
			closedPort = socket.getLocalPort();
		}
		MonitoredService svc = new MonitoredService("id", "gone", "", "", "", "", "http://127.0.0.1:" + closedPort,
				"/actuator/health", "", "", false, 1000, true, "", MonitoredService.SOURCE_UI, null, null);

		CheckResult r = checker.check(svc);

		assertThat(r.status()).isEqualTo(Status.DOWN);
		assertThat(r.error()).isEqualTo("Connection refused — pod down or wrong port");
	}

}
