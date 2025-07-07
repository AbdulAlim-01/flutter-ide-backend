# Use the Flutter Docker image
FROM fischerscode/flutter:stable

# Switch to root so we can install packages
USER root

# Install Node.js and npm
RUN apt-get update && apt-get install -y nodejs npm

# Set working directory
WORKDIR /app

# Copy backend files
COPY package.json package-lock.json ./
RUN npm install
COPY server.js ./

# Expose and start
EXPOSE 4000
CMD ["node", "server.js"]
