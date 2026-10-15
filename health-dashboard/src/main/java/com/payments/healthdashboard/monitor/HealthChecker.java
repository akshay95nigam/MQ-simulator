package com.payments.healthdashboard.monitor;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import com.payments.healthdashboard.model.CheckResult;
import com.payments.healthdashboard.model.CheckResult.BuildInfo;
import com.payments.healthdashboard.model.CheckResult.Component;
import com.payments.healthdashboard.model.CheckResult.Probes;
import com.payments.healthdashboard.model.MonitoredService;
import com.payments.healthdashboard.model.Status;
import tools.jackson.databind.JsonNode;

/**
 * Calls a service's actuator endpoints and classifies the result as
 * up / degraded / down / unknown.
 */
@org.springframework.stereotype.Component
public class HealthChecker {

	static final String NOT_EXPOSED = "NOT_EXPOSED";

	static final String UNREACHABLE = "UNREACHABLE";

	private final ActuatorClient client;

	private final ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor();

	public HealthChecker(ActuatorClient client) {
		this.client = client;
	}

	public CheckResult check(MonitoredService svc) {
		Instant checkedAt = Instant.now();
		String token = svc.authToken();
		ActuatorClient.Response health;
		try {
			health = client.get(svc.baseUrl() + svc.healthPath(), token);
		}
		catch (InterruptedException ex) {
			Thread.currentThread().interrupt();
			return down(checkedAt, null, null, "Check interrupted");
		}
		catch (Exception ex) {
			return down(checkedAt, null, null, client.describe(ex));
		}

		JsonNode body = health.body();
		if (body == null || !body.hasNonNull("status")) {
			return down(checkedAt, health.httpStatus(), health.latencyMs(), describeNonActuator(health.httpStatus()));
		}

		String springStatus = body.get("status").asString().toUpperCase(Locale.ROOT);
		List<Component> components = new ArrayList<>();
		flatten(body, "", components);

		CompletableFuture<Probes> probes = svc.checkProbes()
				? CompletableFuture.supplyAsync(() -> new Probes(
						probe(svc.baseUrl() + svc.healthPath() + "/liveness", token),
						probe(svc.baseUrl() + svc.healthPath() + "/readiness", token)), executor)
				: CompletableFuture.completedFuture(null);
		CompletableFuture<BuildInfo> info = svc.infoPath().isEmpty() ? CompletableFuture.completedFuture(null)
				: CompletableFuture.supplyAsync(() -> info(svc.baseUrl() + svc.infoPath(), token), executor);

		return classify(svc, checkedAt, health, springStatus, components, probes.join(), info.join());
	}

	private CheckResult classify(MonitoredService svc, Instant checkedAt, ActuatorClient.Response health,
			String springStatus, List<Component> components, Probes probes, BuildInfo info) {
		List<String> reasons = new ArrayList<>();
		Status status;
		List<Component> notUp = components.stream().filter((c) -> !"UP".equals(c.status())).toList();

		if ("DOWN".equals(springStatus) || "OUT_OF_SERVICE".equals(springStatus)) {
			status = Status.DOWN;
			reasons.add(notUp.isEmpty() ? "Service reports " + springStatus
					: "Failing: " + String.join(", ", notUp.stream().map(Component::name).toList()));
		}
		else if ("UP".equals(springStatus)) {
			if (!notUp.isEmpty()) {
				reasons.add("Components not UP: " + String.join(", ",
						notUp.stream().map((c) -> c.name() + " (" + c.status() + ")").toList()));
			}
			if (probes != null && isProblem(probes.readiness())) {
				reasons.add("Readiness is " + probes.readiness() + " — not receiving traffic");
			}
			if (probes != null && isProblem(probes.liveness())) {
				reasons.add("Liveness is " + probes.liveness() + " — pod may be restarted");
			}
			if (health.latencyMs() > svc.slowThresholdMs()) {
				reasons.add("Slow response: " + health.latencyMs() + " ms (threshold " + svc.slowThresholdMs() + " ms)");
			}
			status = reasons.isEmpty() ? Status.UP : Status.DEGRADED;
		}
		else {
			status = Status.UNKNOWN;
			reasons.add("Service reports " + springStatus);
		}
		return new CheckResult(checkedAt, status, springStatus, health.httpStatus(), health.latencyMs(),
				List.copyOf(components), probes, info, null, List.copyOf(reasons));
	}

	private static boolean isProblem(String probeStatus) {
		return !"UP".equals(probeStatus) && !NOT_EXPOSED.equals(probeStatus);
	}

	private static CheckResult down(Instant checkedAt, Integer httpStatus, Long latencyMs, String error) {
		return new CheckResult(checkedAt, Status.DOWN, null, httpStatus, latencyMs, List.of(), null, null, error,
				List.of());
	}

	private static String describeNonActuator(int httpStatus) {
		if (httpStatus == 401 || httpStatus == 403) {
			return "HTTP " + httpStatus + " — health endpoint requires auth; add a bearer token";
		}
		if (httpStatus == 503) {
			return "HTTP 503 with no health body — OpenShift route has no ready pods behind it";
		}
		if (httpStatus == 404) {
			return "HTTP 404 — health endpoint not found; check the path and management.endpoints.web.exposure.include";
		}
		return "HTTP " + httpStatus + " — response is not an actuator health document";
	}

	/** Spring Boot 2.2+ uses "components", older versions "details"; nested composites are flattened. */
	static void flatten(JsonNode node, String prefix, List<Component> out) {
		JsonNode children = node.has("components") ? node.get("components") : node.get("details");
		if (children == null || !children.isObject()) {
			return;
		}
		for (Map.Entry<String, JsonNode> entry : children.properties()) {
			JsonNode child = entry.getValue();
			if (!child.isObject() || !child.hasNonNull("status")) {
				continue;
			}
			String name = prefix.isEmpty() ? entry.getKey() : prefix + "." + entry.getKey();
			int before = out.size();
			flatten(child, name, out);
			if (out.size() == before) {
				JsonNode details = child.get("details");
				out.add(new Component(name, child.get("status").asString().toUpperCase(Locale.ROOT),
						details != null && details.isObject() ? details : null));
			}
		}
	}

	private String probe(String url, String token) {
		try {
			ActuatorClient.Response r = client.get(url, token);
			if (r.body() != null && r.body().hasNonNull("status")) {
				return r.body().get("status").asString().toUpperCase(Locale.ROOT);
			}
			return r.httpStatus() == 404 ? NOT_EXPOSED : "HTTP " + r.httpStatus();
		}
		catch (InterruptedException ex) {
			Thread.currentThread().interrupt();
			return UNREACHABLE;
		}
		catch (Exception ex) {
			return UNREACHABLE;
		}
	}

	private BuildInfo info(String url, String token) {
		try {
			JsonNode body = client.get(url, token).body();
			if (body == null) {
				return null;
			}
			JsonNode build = body.path("build");
			JsonNode git = body.path("git");
			JsonNode commitId = git.path("commit").path("id");
			String commit = commitId.isString() ? abbreviate(commitId.asString()) : text(commitId.path("abbrev"));
			return new BuildInfo(firstText(build.path("version"), body.path("app").path("version")),
					firstText(build.path("artifact"), build.path("name")), text(build.path("time")), commit,
					text(git.path("branch")), text(body.path("java").path("version")));
		}
		catch (InterruptedException ex) {
			Thread.currentThread().interrupt();
			return null;
		}
		catch (Exception ex) {
			return null;
		}
	}

	private static String abbreviate(String commit) {
		return commit.length() > 7 ? commit.substring(0, 7) : commit;
	}

	private static String text(JsonNode node) {
		return node.isValueNode() && !node.isNull() ? node.asString() : null;
	}

	private static String firstText(JsonNode a, JsonNode b) {
		String t = text(a);
		return t != null ? t : text(b);
	}

}
