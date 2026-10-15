package com.payments.healthdashboard.web;

import java.util.List;
import java.util.Map;

import com.payments.healthdashboard.demo.DemoCatalog;
import com.payments.healthdashboard.model.DashboardSnapshot;
import com.payments.healthdashboard.model.MonitoredService;
import com.payments.healthdashboard.model.ServiceHealth;
import com.payments.healthdashboard.model.ServiceRequest;
import com.payments.healthdashboard.model.ServiceView;
import com.payments.healthdashboard.monitor.HealthMonitor;
import com.payments.healthdashboard.monitor.ServiceRegistry;

import org.springframework.beans.factory.ObjectProvider;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

/** REST API behind the dashboard page. */
@RestController
@RequestMapping("/api")
public class DashboardController {

	private final ServiceRegistry registry;

	private final HealthMonitor monitor;

	private final ObjectProvider<DemoCatalog> demoCatalog;

	public DashboardController(ServiceRegistry registry, HealthMonitor monitor, ObjectProvider<DemoCatalog> demoCatalog) {
		this.registry = registry;
		this.monitor = monitor;
		this.demoCatalog = demoCatalog;
	}

	@GetMapping("/services")
	public List<ServiceView> services() {
		return registry.list().stream().map(ServiceView::of).toList();
	}

	@PostMapping("/services")
	@ResponseStatus(HttpStatus.CREATED)
	public ServiceView create(@RequestBody ServiceRequest request) {
		MonitoredService created = registry.create(request);
		monitor.checkSoon(created.id());
		return ServiceView.of(created);
	}

	@PutMapping("/services/{id}")
	public ServiceView update(@PathVariable String id, @RequestBody ServiceRequest request) {
		MonitoredService updated = registry.update(id, request);
		monitor.forget(id);
		monitor.checkSoon(id);
		return ServiceView.of(updated);
	}

	@DeleteMapping("/services/{id}")
	public ResponseEntity<Void> delete(@PathVariable String id) {
		registry.delete(id);
		monitor.forget(id);
		return ResponseEntity.noContent().build();
	}

	/** Adds the sample payment pipeline served under /demo. */
	@PostMapping("/services/demo")
	@ResponseStatus(HttpStatus.CREATED)
	public Map<String, Integer> loadDemo() {
		DemoCatalog catalog = demoCatalog.getIfAvailable();
		if (catalog == null) {
			throw new ServiceRegistry.NotFoundException();
		}
		int added = registry.addIfAbsent(catalog.serviceRequests());
		monitor.checkAll();
		return Map.of("added", added);
	}

	@GetMapping("/health")
	public DashboardSnapshot health() {
		return monitor.snapshot();
	}

	@PostMapping("/health/check")
	public DashboardSnapshot checkNow() {
		monitor.checkAll();
		return monitor.snapshot();
	}

	@PostMapping("/health/check/{id}")
	public ServiceHealth checkOne(@PathVariable String id) {
		return monitor.checkOne(id).orElseThrow(ServiceRegistry.NotFoundException::new);
	}

}
