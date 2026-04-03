# Use Node.js as the base image
FROM node:18-slim

# Create and set the working directory
WORKDIR /app

# Copy only the package files first to leverage Docker's layer caching
COPY package*.json ./

# Install dependencies, including better-sqlite3 which may require build tools
RUN apt-get update && apt-get install -y python3 make g++ \
    && npm install --omit=dev \
    && apt-get purge -y python3 make g++ \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# Copy the rest of the application code
COPY . .

# Ensure the database file is writeable or initialize it if it doesn't exist
# (SQLite works best on a persistent volume, so if you're using a container-based platform,
# make sure to mount a volume to /app/symptoms.db for persistence)
# Alternatively, ensure the application can create it on startup.

# Set the port the app runs on
EXPOSE 3000

# Start the application
CMD ["node", "server.js"]
