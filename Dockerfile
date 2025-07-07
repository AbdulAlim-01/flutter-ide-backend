# Base Flutter SDK image with Linux
FROM fischerscode/flutter:stable

# Install Node.js and npm
RUN apt-get update && apt-get install -y nodejs npm

# Set working directory
WORKDIR /app

# Copy Node.js files
COPY package.json package-lock.json ./
RUN npm install

# Copy backend server code
COPY server.js ./

# Expose backend port
EXPOSE 4000

# Start backend server
CMD ["node", "server.js"]
