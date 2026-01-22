/**
 * DOM Element Cache
 * Caches frequently accessed DOM elements to avoid repeated queries
 * Improves performance by reducing DOM lookups
 */

export class DOMCache {
  private cache: Map<string, HTMLElement> = new Map();

  /**
   * Get element by ID, using cache if available
   * @param id - Element ID
   * @returns Cached or newly queried element, or null if not found
   */
  get(id: string): HTMLElement | null {
    if (this.cache.has(id)) {
      const cached = this.cache.get(id)!;
      // Verify element is still in document (not detached)
      if (document.contains(cached)) {
        return cached;
      }
      // Element was removed from DOM, invalidate cache
      this.cache.delete(id);
    }

    const element = document.getElementById(id);
    if (element) {
      this.cache.set(id, element);
    }
    return element;
  }

  /**
   * Pre-cache multiple elements by their IDs
   * @param ids - Array of element IDs to cache
   */
  cacheElements(ids: string[]): void {
    ids.forEach((id) => {
      const element = document.getElementById(id);
      if (element) {
        this.cache.set(id, element);
      }
    });
  }

  /**
   * Clear the cache (useful for cleanup or when DOM changes)
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Remove a specific element from cache
   * @param id - Element ID to remove
   */
  remove(id: string): void {
    this.cache.delete(id);
  }

  /**
   * Check if element is cached
   * @param id - Element ID
   */
  has(id: string): boolean {
    return this.cache.has(id);
  }

  /**
   * Get cache size
   */
  get size(): number {
    return this.cache.size;
  }
}

// Export singleton instance for global use
export const domCache = new DOMCache();
