package com.payments.healthdashboard.web;

import java.util.Map;

import com.payments.healthdashboard.monitor.ServiceRegistry;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

/** Errors as {@code {"error": "..."}}, which the dashboard page shows to the user. */
@RestControllerAdvice
public class ApiExceptionHandler {

	@ExceptionHandler(IllegalArgumentException.class)
	public ResponseEntity<Map<String, String>> badRequest(IllegalArgumentException ex) {
		return error(HttpStatus.BAD_REQUEST, ex.getMessage());
	}

	@ExceptionHandler(HttpMessageNotReadableException.class)
	public ResponseEntity<Map<String, String>> unreadable(HttpMessageNotReadableException ex) {
		return error(HttpStatus.BAD_REQUEST, "Request body is not valid JSON for this endpoint.");
	}

	@ExceptionHandler(ServiceRegistry.NotFoundException.class)
	public ResponseEntity<Map<String, String>> notFound(ServiceRegistry.NotFoundException ex) {
		return error(HttpStatus.NOT_FOUND, ex.getMessage());
	}

	@ExceptionHandler(ServiceRegistry.ConfigManagedException.class)
	public ResponseEntity<Map<String, String>> configManaged(ServiceRegistry.ConfigManagedException ex) {
		return error(HttpStatus.CONFLICT, ex.getMessage());
	}

	private static ResponseEntity<Map<String, String>> error(HttpStatus status, String message) {
		return ResponseEntity.status(status).body(Map.of("error", message));
	}

}
