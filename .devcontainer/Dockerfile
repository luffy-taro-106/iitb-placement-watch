FROM mcr.microsoft.com/playwright:v1.64.0-noble
USER root
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    xvfb x11-utils x11vnc novnc websockify xfce4 dbus-x11 curl ca-certificates gh \
    && apt-get clean && rm -rf /var/lib/apt/lists/*
ENV DISPLAY=:99
ENV NODE_ENV=development
WORKDIR /workspaces/iitb-placement-free
