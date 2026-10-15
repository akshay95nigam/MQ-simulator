package com.payments.healthdashboard.model;

/** What the browser sees of a service: everything except the bearer token. */
public record ServiceView(
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
		boolean hasAuthToken,
		boolean configManaged) {

	public static ServiceView of(MonitoredService s) {
		return new ServiceView(s.id(), s.name(), s.stage(), s.environment(), s.namespace(), s.description(),
				s.baseUrl(), s.healthPath(), s.infoPath(), s.consoleUrl(), s.checkProbes(), s.slowThresholdMs(),
				s.enabled(), s.hasAuthToken(), s.isConfigManaged());
	}

}
