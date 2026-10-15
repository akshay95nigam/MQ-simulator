package com.payments.healthdashboard.model;

import java.time.Instant;
import java.util.List;

/** Everything the dashboard page needs in one response. */
public record DashboardSnapshot(long pollIntervalMs, long timeoutMs, Instant lastRunAt, boolean demoAvailable,
		List<Entry> services, List<StatusEvent> events) {

	public record Entry(ServiceView service, ServiceHealth health) {
	}

}
