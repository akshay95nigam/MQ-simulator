package com.payments.healthdashboard.model;

import java.time.Instant;

/** A change in a service's dashboard status. */
public record StatusEvent(Instant at, String serviceId, String serviceName, Status from, Status to, String detail) {
}
