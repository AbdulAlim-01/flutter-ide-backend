# Use the Flutter Docker image
FROM fischerscode/flutter:stable

# Switch to root so we can install packages
USER root

# Install Node.js and npm
RUN apt-get update && apt-get install -y nodejs npm

# Set working directory
WORKDIR /app

# Copy package manifests and install dependencies to leverage Docker layer caching
COPY package.json package-lock.json* ./
RUN npm install

# Copy the rest of the application
COPY server.js ./

# Expose the correct port that the server listens on
EXPOSE 3000

# Start the server
CMD ["node", "server.js"]
