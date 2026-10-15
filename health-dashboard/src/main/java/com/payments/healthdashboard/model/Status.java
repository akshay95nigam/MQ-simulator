package com.payments.healthdashboard.model;

import com.fasterxml.jackson.annotation.JsonValue;

/** Dashboard status of a service, derived from its actuator responses. */
public enum Status {

	/** Actuator UP, every component and probe UP, response under the slow threshold. */
	UP,

	/** Actuator UP, but a component or probe is not, or the response was slow. */
	DEGRADED,

	/** Actuator DOWN/OUT_OF_SERVICE, unreachable, timed out, or not an actuator response. */
	DOWN,

	/** Actuator reported a status this dashboard doesn't recognise. */
	UNKNOWN;

	@JsonValue
	public String json() {
		return name().toLowerCase();
	}

}
