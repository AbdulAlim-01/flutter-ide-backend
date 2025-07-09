# Use the Flutter Docker image
FROM fischerscode/flutter:stable

# Switch to root so we can install packages
USER root

# Install Node.js and npm
RUN apt-get update && apt-get install -y nodejs npm

# Set an environment variable for the port
ENV NODE_ENV=production
ENV PORT=3000

# Set working directory
WORKDIR /app

# Copy package manifests and install dependencies
COPY package.json package-lock.json* ./
RUN npm install

# Copy the rest of the application
COPY server.js ./

# Expose the port defined in the ENV instruction
EXPOSE ${PORT}

# Start the server
CMD ["node", "server.js"]
