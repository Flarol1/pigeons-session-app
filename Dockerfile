# Use a standard Node.js base image
FROM node:18-slim

# Create and set the working directory
WORKDIR /usr/src/app

# Copy package.json and package-lock.json to install dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy the rest of your application code, including your data.db file
COPY . .

# Cloud Run will use the PORT environment variable
# Define the command to run your app
CMD [ "node", "server.js" ]