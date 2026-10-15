# Build: docker build -t payment-health-dashboard .   (or oc start-build, see README)
FROM registry.access.redhat.com/ubi9/openjdk-21:latest AS build
USER root
WORKDIR /build
COPY pom.xml .
RUN mvn -B -q dependency:go-offline
COPY src src
RUN mvn -B -q package -DskipTests

# Red Hat UBI runtime image: runs as a non-root arbitrary UID, as OpenShift requires.
FROM registry.access.redhat.com/ubi9/openjdk-21-runtime:latest
COPY --from=build /build/target/payment-health-dashboard-*.jar /deployments/app.jar
ENV JAVA_APP_JAR=/deployments/app.jar \
    JAVA_OPTS_APPEND="-XX:MaxRAMPercentage=75"
EXPOSE 8080
