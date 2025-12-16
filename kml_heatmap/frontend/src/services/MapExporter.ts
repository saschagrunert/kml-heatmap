/**
 * Map export service for capturing screenshots
 */

export class MapExporter {
  private map: any; // L.Map - using any to avoid Leaflet type resolution issues

  constructor(map: any) {
    this.map = map;
  }

  /**
   * Export map as image using leaflet-image or domtoimage
   */
  async exportAsImage(filename: string = "flight-map.jpg"): Promise<void> {
    try {
      // Use domtoimage library (loaded via CDN in template)
      const domtoimage = window.domtoimage;

      if (!domtoimage) {
        console.error("domtoimage library not loaded");
        alert("Export functionality requires domtoimage library");
        return;
      }

      const mapElement = this.map.getContainer();

      // Show loading indicator
      const originalCursor = mapElement.style.cursor;
      mapElement.style.cursor = "wait";

      // Generate image
      const blob = await domtoimage.toBlob(mapElement, {
        quality: 0.95,
        bgcolor: "#1a1a1a",
      });

      // Restore cursor
      mapElement.style.cursor = originalCursor;

      // Download the image
      const link = document.createElement("a");
      link.download = filename;
      link.href = URL.createObjectURL(blob);
      link.click();

      // Cleanup
      URL.revokeObjectURL(link.href);
    } catch (error) {
      console.error("Export failed:", error);
      alert("Failed to export map image");
    }
  }

  /**
   * Export using canvas-based approach (fallback)
   */
  async exportAsCanvasImage(
    filename: string = "flight-map.jpg",
  ): Promise<void> {
    try {
      const mapElement = this.map.getContainer();
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");

      if (!context) {
        throw new Error("Failed to get canvas context");
      }

      // Set canvas size to map size
      const rect = mapElement.getBoundingClientRect();
      canvas.width = rect.width;
      canvas.height = rect.height;

      // This is a simplified approach - real implementation would need
      // to render all map tiles and overlays to canvas
      context.fillStyle = "#1a1a1a";
      context.fillRect(0, 0, canvas.width, canvas.height);

      // Convert canvas to blob
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            throw new Error("Failed to create blob");
          }

          const link = document.createElement("a");
          link.download = filename;
          link.href = URL.createObjectURL(blob);
          link.click();
          URL.revokeObjectURL(link.href);
        },
        "image/jpeg",
        0.95,
      );
    } catch (error) {
      console.error("Canvas export failed:", error);
      alert("Failed to export map image");
    }
  }
}
