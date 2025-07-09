# Use a Flutter base image with Node.js installation capability
FROM cirrusci/flutter:stable

# Switch to root user to install dependencies
USER root

# Install system dependencies for Node.js, npm, and other tooling
RUN apt-get update && \
    apt-get install -y curl gnupg2 build-essential && \
    curl -fsSL https://deb.nodesource.com/setup_18.x | bash - && \
    apt-get install -y nodejs && \
    npm install -g npm && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3000

# Create and set working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package.json package-lock.json* ./
RUN npm install

# Copy entire app (includes server.js and other files)
COPY . .

# Ensure Flutter is installed and pre-cached to speed up commands
RUN flutter doctor -v

# Expose server port
EXPOSE ${PORT}

# Start the Express server
CMD ["node", "server.js"]
