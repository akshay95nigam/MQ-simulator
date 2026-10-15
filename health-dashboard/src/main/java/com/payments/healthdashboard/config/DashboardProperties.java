package com.payments.healthdashboard.config;

import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Settings under {@code dashboard.*}. Services listed under
 * {@code dashboard.services} come from configuration (e.g. an OpenShift
 * ConfigMap) and are read-only in the UI; services added in the UI are kept
 * in {@link #getStoreFile()}.
 */
@ConfigurationProperties("dashboard")
public class DashboardProperties {

	/** How often every enabled service is polled. */
	private Duration pollInterval = Duration.ofSeconds(15);

	/** Connect and read timeout for each actuator call. */
	private Duration timeout = Duration.ofSeconds(5);

	/** Number of recent checks kept per service for the timeline. */
	private int historyLength = 60;

	/** Number of status-change events kept in memory. */
	private int maxEvents = 200;

	/** JSON file holding services added through the UI. */
	private Path storeFile = Path.of("data", "services.json");

	/**
	 * Name of a Spring SSL bundle ({@code spring.ssl.bundle.*}) whose trust
	 * material is used for HTTPS calls — e.g. the cluster or ingress CA.
	 * Blank uses the JVM default truststore.
	 */
	private String sslBundle = "";

	private final Demo demo = new Demo();

	private List<ServiceDefinition> services = new ArrayList<>();

	public Duration getPollInterval() { return pollInterval; }
	public void setPollInterval(Duration pollInterval) { this.pollInterval = pollInterval; }
	public Duration getTimeout() { return timeout; }
	public void setTimeout(Duration timeout) { this.timeout = timeout; }
	public int getHistoryLength() { return historyLength; }
	public void setHistoryLength(int historyLength) { this.historyLength = historyLength; }
	public int getMaxEvents() { return maxEvents; }
	public void setMaxEvents(int maxEvents) { this.maxEvents = maxEvents; }
	public Path getStoreFile() { return storeFile; }
	public void setStoreFile(Path storeFile) { this.storeFile = storeFile; }
	public String getSslBundle() { return sslBundle; }
	public void setSslBundle(String sslBundle) { this.sslBundle = sslBundle; }
	public Demo getDemo() { return demo; }
	public List<ServiceDefinition> getServices() { return services; }
	public void setServices(List<ServiceDefinition> services) { this.services = services; }

	public static class Demo {

		/** Serve fake actuator endpoints under /demo for trying the dashboard. */
		private boolean enabled = true;

		public boolean isEnabled() { return enabled; }
		public void setEnabled(boolean enabled) { this.enabled = enabled; }

	}

	/** A monitored service declared in configuration. */
	public static class ServiceDefinition {

		private String name;
		private String stage = "";
		private String environment = "";
		private String namespace = "";
		private String description = "";
		private String baseUrl;
		private String healthPath = "/actuator/health";
		private String infoPath = "/actuator/info";
		private String consoleUrl = "";
		private boolean checkProbes = true;
		private long slowThresholdMs = 1000;
		private boolean enabled = true;
		/** Bearer token; reference a Secret-backed env var, e.g. ${TRANSFORMER_TOKEN:}. */
		private String authToken = "";

		public String getName() { return name; }
		public void setName(String name) { this.name = name; }
		public String getStage() { return stage; }
		public void setStage(String stage) { this.stage = stage; }
		public String getEnvironment() { return environment; }
		public void setEnvironment(String environment) { this.environment = environment; }
		public String getNamespace() { return namespace; }
		public void setNamespace(String namespace) { this.namespace = namespace; }
		public String getDescription() { return description; }
		public void setDescription(String description) { this.description = description; }
		public String getBaseUrl() { return baseUrl; }
		public void setBaseUrl(String baseUrl) { this.baseUrl = baseUrl; }
		public String getHealthPath() { return healthPath; }
		public void setHealthPath(String healthPath) { this.healthPath = healthPath; }
		public String getInfoPath() { return infoPath; }
		public void setInfoPath(String infoPath) { this.infoPath = infoPath; }
		public String getConsoleUrl() { return consoleUrl; }
		public void setConsoleUrl(String consoleUrl) { this.consoleUrl = consoleUrl; }
		public boolean isCheckProbes() { return checkProbes; }
		public void setCheckProbes(boolean checkProbes) { this.checkProbes = checkProbes; }
		public long getSlowThresholdMs() { return slowThresholdMs; }
		public void setSlowThresholdMs(long slowThresholdMs) { this.slowThresholdMs = slowThresholdMs; }
		public boolean isEnabled() { return enabled; }
		public void setEnabled(boolean enabled) { this.enabled = enabled; }
		public String getAuthToken() { return authToken; }
		public void setAuthToken(String authToken) { this.authToken = authToken; }

	}

}
