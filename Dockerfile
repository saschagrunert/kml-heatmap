# KML Heatmap Generator Docker Image
FROM python:3.14-slim

# Set working directory
WORKDIR /app

# Copy requirements first for better caching
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy the application
COPY kml-heatmap.py .

# Create directory for input/output files
RUN mkdir -p /data

# Set working directory to /data for file operations
WORKDIR /data

# Set the script as entrypoint
ENTRYPOINT ["python", "/app/kml-heatmap.py"]

# Default command (show help if no arguments)
CMD []
