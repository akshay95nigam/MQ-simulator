package com.payments.healthdashboard.model;

import java.time.Instant;

/**
 * A Spring Boot service whose actuator endpoints are polled.
 *
 * @param source {@code config} when declared in application configuration
 * (read-only in the UI), {@code ui} when added through the dashboard
 */
public record MonitoredService(
		String id,
		String name,
		String stage,
		String environment,
		String namespace,
		String description,
		String baseUrl,
		String healthPath,
		String infoPath,
		String consoleUrl,
		boolean checkProbes,
		long slowThresholdMs,
		boolean enabled,
		String authToken,
		String source,
		Instant createdAt,
		Instant updatedAt) {

	public static final String SOURCE_CONFIG = "config";

	public static final String SOURCE_UI = "ui";

	public boolean hasAuthToken() {
		return authToken != null && !authToken.isEmpty();
	}

	public boolean isConfigManaged() {
		return SOURCE_CONFIG.equals(source);
	}

}
