# Use the Flutter Docker image
FROM fischerscode/flutter:stable

# Install curl and a modern version of Node.js (18.x)
# Then install other dependencies for the healthcheck
RUN apt-get update --fix-missing && \
    apt-get upgrade -y && \
    apt-get install -y curl && \
    curl -fsSL https://deb.nodesource.com/setup_18.x | bash - && \
    apt-get install -y nodejs && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Create a non-root user
RUN groupadd --gid 1000 node && \
    useradd --uid 1000 --gid node --shell /bin/bash --create-home node

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3000

# Set working directory
WORKDIR /app

# Copy package manifests
COPY package.json package-lock.json* ./

# Change ownership of the app directory
RUN chown -R node:node /app

# Switch to the non-root user
USER node

# Install dependencies
RUN npm install

# Copy the rest of the application
COPY --chown=node:node server.js ./

# Expose the application port
EXPOSE ${PORT}

# Add a healthcheck to ensure the server is responsive
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:${PORT}/health || exit 1

# Start the server
CMD ["node", "server.js"]
