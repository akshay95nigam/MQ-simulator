package com.payments.healthdashboard.model;

import java.time.Instant;
import java.util.List;

import tools.jackson.databind.JsonNode;

/** Outcome of one round of actuator calls against a service. */
public record CheckResult(
		Instant checkedAt,
		Status status,
		String springStatus,
		Integer httpStatus,
		Long latencyMs,
		List<Component> components,
		Probes probes,
		BuildInfo info,
		String error,
		List<String> reasons) {

	/** A leaf health indicator, e.g. {@code db} or {@code db.primary}. */
	public record Component(String name, String status, JsonNode details) {
	}

	/** Kubernetes probe groups; {@code NOT_EXPOSED} when the group returns 404. */
	public record Probes(String liveness, String readiness) {
	}

	/** Selected fields from {@code /actuator/info}. */
	public record BuildInfo(String version, String artifact, String buildTime, String commit, String branch,
			String java) {
	}

}
