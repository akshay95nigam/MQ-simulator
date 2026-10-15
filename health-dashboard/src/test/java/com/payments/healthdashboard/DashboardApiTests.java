package com.payments.healthdashboard;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Path;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
		"dashboard.poll-interval=1h",
		"dashboard.services[0].name=config-transformer",
		"dashboard.services[0].stage=Transformation",
		"dashboard.services[0].namespace=payments-prod",
		"dashboard.services[0].base-url=http://127.0.0.1:9/",
		"dashboard.services[0].auth-token=config-secret" })
class DashboardApiTests {

	@TempDir
	static Path tempDir;

	@DynamicPropertySource
	static void storeFile(DynamicPropertyRegistry registry) {
		registry.add("dashboard.store-file", () -> tempDir.resolve("services.json").toString());
	}

	@LocalServerPort
	int port;

	@Autowired
	JsonMapper jsonMapper;

	private final HttpClient http = HttpClient.newHttpClient();

	private HttpResponse<String> call(String method, String path, String body) throws Exception {
		HttpRequest request = HttpRequest.newBuilder(URI.create("http://localhost:" + port + path))
			.header("Content-Type", "application/json")
			.method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(body))
			.build();
		return http.send(request, HttpResponse.BodyHandlers.ofString());
	}

	private JsonNode json(HttpResponse<String> response) {
		return jsonMapper.readTree(response.body());
	}

	@Test
	void tokensAreStoredButNeverReturned() throws Exception {
		HttpResponse<String> created = call("POST", "/api/services", """
				{"name":"router","baseUrl":"http://127.0.0.1:9","authToken":"ui-secret"}""");
		assertThat(created.statusCode()).isEqualTo(201);
		assertThat(json(created).get("hasAuthToken").asBoolean()).isTrue();

		String id = json(created).get("id").asString();
		HttpResponse<String> updated = call("PUT", "/api/services/" + id, """
				{"name":"router-renamed","baseUrl":"http://127.0.0.1:9"}""");
		assertThat(json(updated).get("hasAuthToken").asBoolean()).as("blank token on edit keeps the saved one").isTrue();

		for (String path : new String[] { "/api/services", "/api/health" }) {
			String body = call("GET", path, null).body();
			assertThat(body).contains("router-renamed").doesNotContain("ui-secret").doesNotContain("config-secret");
		}
		assertThat(tempDir.resolve("services.json")).content().contains("ui-secret");
	}

	@Test
	void configServicesAreReadOnly() throws Exception {
		JsonNode services = json(call("GET", "/api/services", null));
		JsonNode config = null;
		for (JsonNode s : services) {
			if (s.get("name").asString().equals("config-transformer")) {
				config = s;
			}
		}
		assertThat(config).isNotNull();
		assertThat(config.get("configManaged").asBoolean()).isTrue();
		assertThat(config.get("baseUrl").asString()).isEqualTo("http://127.0.0.1:9");

		String id = config.get("id").asString();
		assertThat(call("PUT", "/api/services/" + id, "{\"name\":\"x\",\"baseUrl\":\"http://a\"}").statusCode())
			.isEqualTo(409);
		assertThat(call("DELETE", "/api/services/" + id, null).statusCode()).isEqualTo(409);
	}

	@Test
	void rejectsInvalidServices() throws Exception {
		HttpResponse<String> response = call("POST", "/api/services", "{\"name\":\"x\",\"baseUrl\":\"ftp://host\"}");
		assertThat(response.statusCode()).isEqualTo(400);
		assertThat(json(response).get("error").asString()).contains("http://");
		assertThat(call("DELETE", "/api/services/does-not-exist", null).statusCode()).isEqualTo(404);
	}

	@Test
	void demoPipelineIsCheckedAndExportedAsMetrics() throws Exception {
		HttpResponse<String> demo = call("POST", "/api/services/demo", null);
		assertThat(demo.statusCode()).isEqualTo(201);

		JsonNode snapshot = json(call("GET", "/api/health", null));
		assertThat(snapshot.get("demoAvailable").asBoolean()).isTrue();
		assertThat(snapshot.get("lastRunAt").isString()).as("timestamps serialise as ISO strings").isTrue();
		int checkedDemoServices = 0;
		for (JsonNode entry : snapshot.get("services")) {
			if (entry.get("service").get("namespace").asString().equals("payments-demo")) {
				JsonNode health = entry.get("health");
				assertThat(health.get("status").asString()).isIn("up", "degraded", "down");
				assertThat(health.get("info").get("version").isString()).isTrue();
				checkedDemoServices++;
			}
		}
		assertThat(checkedDemoServices).isEqualTo(8);

		String metrics = call("GET", "/actuator/prometheus", null).body();
		assertThat(metrics).contains("payment_service_up{")
			.contains("payment_service_degraded{")
			.contains("payment_service_health_latency_milliseconds{")
			.contains("service=\"payment-transformer\"");
	}

	@Test
	void exposesOwnProbes() throws Exception {
		assertThat(json(call("GET", "/actuator/health/liveness", null)).get("status").asString()).isEqualTo("UP");
		assertThat(json(call("GET", "/actuator/health/readiness", null)).get("status").asString()).isEqualTo("UP");
	}

	@Test
	void servesDashboardPage() throws Exception {
		HttpResponse<String> page = call("GET", "/", null);
		assertThat(page.statusCode()).isEqualTo(200);
		assertThat(page.body()).contains("<title>Service Health</title>");
	}

}
