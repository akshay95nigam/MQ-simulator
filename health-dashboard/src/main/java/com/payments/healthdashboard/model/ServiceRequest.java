package com.payments.healthdashboard.model;

/** Body of create/update requests from the dashboard UI. Null fields take defaults. */
public record ServiceRequest(
		String name,
		String stage,
		String environment,
		String namespace,
		String description,
		String baseUrl,
		String healthPath,
		String infoPath,
		String consoleUrl,
		Boolean checkProbes,
		Long slowThresholdMs,
		Boolean enabled,
		String authToken,
		Boolean clearAuthToken) {
}
