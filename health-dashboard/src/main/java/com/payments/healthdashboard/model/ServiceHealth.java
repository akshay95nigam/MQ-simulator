package com.payments.healthdashboard.model;

import java.time.Instant;
import java.util.List;

import com.payments.healthdashboard.model.CheckResult.BuildInfo;
import com.payments.healthdashboard.model.CheckResult.Component;
import com.payments.healthdashboard.model.CheckResult.Probes;

/** Latest check for a service plus how long it has held that status and its recent history. */
public record ServiceHealth(
		Instant checkedAt,
		Status status,
		String springStatus,
		Integer httpStatus,
		Long latencyMs,
		List<Component> components,
		Probes probes,
		BuildInfo info,
		String error,
		List<String> reasons,
		Instant since,
		List<HistoryPoint> history) {

	public record HistoryPoint(Instant at, Status status, Long latencyMs) {
	}

	public static ServiceHealth of(CheckResult r, Instant since, List<HistoryPoint> history) {
		return new ServiceHealth(r.checkedAt(), r.status(), r.springStatus(), r.httpStatus(), r.latencyMs(),
				r.components(), r.probes(), r.info(), r.error(), r.reasons(), since, history);
	}

}
