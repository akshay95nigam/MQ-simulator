package com.payments.healthdashboard.monitor;

import java.io.IOException;
import java.net.ConnectException;
import java.net.ProxySelector;
import java.net.URI;
import java.net.UnknownHostException;
import java.net.http.HttpClient;
import java.net.http.HttpConnectTimeoutException;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.nio.channels.UnresolvedAddressException;
import java.security.cert.CertificateException;
import java.time.Duration;
import java.util.concurrent.Executors;

import javax.net.ssl.SSLException;

import com.payments.healthdashboard.config.DashboardProperties;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import org.springframework.boot.ssl.SslBundles;
import org.springframework.stereotype.Component;

/** Thin HTTP client for Spring Boot Actuator endpoints. */
@Component
public class ActuatorClient {

	private static final String ACCEPT = "application/vnd.spring-boot.actuator.v3+json, application/json";

	private final HttpClient httpClient;

	private final Duration timeout;

	private final JsonMapper jsonMapper;

	public ActuatorClient(DashboardProperties properties, SslBundles sslBundles, JsonMapper jsonMapper) {
		this.timeout = properties.getTimeout();
		this.jsonMapper = jsonMapper;
		HttpClient.Builder builder = HttpClient.newBuilder()
			.connectTimeout(timeout)
			.followRedirects(HttpClient.Redirect.NORMAL)
			// Honours http(s).proxyHost / http.nonProxyHosts for corporate egress proxies.
			.proxy(ProxySelector.getDefault())
			.executor(Executors.newVirtualThreadPerTaskExecutor());
		if (!properties.getSslBundle().isBlank()) {
			builder.sslContext(sslBundles.getBundle(properties.getSslBundle()).createSslContext());
		}
		this.httpClient = builder.build();
	}

	/** Response of an actuator call; {@code body} is null when it isn't JSON. */
	public record Response(int httpStatus, JsonNode body, long latencyMs) {
	}

	public Response get(String url, String bearerToken) throws IOException, InterruptedException {
		HttpRequest.Builder request = HttpRequest.newBuilder(URI.create(url)).timeout(timeout).header("Accept", ACCEPT).GET();
		if (bearerToken != null && !bearerToken.isEmpty()) {
			request.header("Authorization", "Bearer " + bearerToken);
		}
		long started = System.nanoTime();
		HttpResponse<String> response = httpClient.send(request.build(), HttpResponse.BodyHandlers.ofString());
		long latencyMs = (System.nanoTime() - started) / 1_000_000;
		return new Response(response.statusCode(), parse(response.body()), latencyMs);
	}

	private JsonNode parse(String body) {
		if (body == null || body.isBlank()) {
			return null;
		}
		try {
			JsonNode node = jsonMapper.readTree(body);
			return node.isObject() ? node : null;
		}
		catch (RuntimeException ex) {
			// Not JSON, e.g. an OpenShift router error page.
			return null;
		}
	}

	/** Turns a transport failure into a hint an on-call engineer can act on. */
	public String describe(Exception ex) {
		for (Throwable t = ex; t != null; t = t.getCause()) {
			if (t instanceof HttpConnectTimeoutException) {
				return "Connect timed out after " + timeout.toMillis() + " ms — host unreachable or blocked by a NetworkPolicy";
			}
			if (t instanceof HttpTimeoutException) {
				return "Timed out after " + timeout.toMillis() + " ms";
			}
			if (t instanceof UnknownHostException || t instanceof UnresolvedAddressException) {
				return "DNS lookup failed — check the route/host name";
			}
			if (t instanceof CertificateException
					|| (t instanceof SSLException && String.valueOf(t.getMessage()).contains("PKIX"))) {
				return "TLS: certificate not trusted — configure dashboard.ssl-bundle with your cluster CA";
			}
			if (t instanceof SSLException) {
				return "TLS handshake failed: " + t.getMessage();
			}
			if (t instanceof ConnectException) {
				return "Connection refused — pod down or wrong port";
			}
		}
		String message = ex.getMessage();
		return ex.getClass().getSimpleName() + (message != null ? ": " + message : "");
	}

}
