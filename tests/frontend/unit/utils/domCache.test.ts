import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DOMCache } from "../../../../kml_heatmap/frontend/utils/domCache";

describe("DOMCache", () => {
  let domCache: DOMCache;

  beforeEach(() => {
    // Clear DOM
    document.body.innerHTML = "";
    // Create new cache instance for each test
    domCache = new DOMCache();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  describe("get", () => {
    it("returns element when found in DOM", () => {
      const element = document.createElement("div");
      element.id = "test-element";
      document.body.appendChild(element);

      const result = domCache.get("test-element");

      expect(result).toBe(element);
      expect(result?.id).toBe("test-element");
    });

    it("returns null when element not found", () => {
      const result = domCache.get("non-existent");

      expect(result).toBeNull();
    });

    it("caches element on first access", () => {
      const element = document.createElement("div");
      element.id = "cached-element";
      document.body.appendChild(element);

      domCache.get("cached-element");

      expect(domCache.has("cached-element")).toBe(true);
      expect(domCache.size).toBe(1);
    });

    it("returns cached element on subsequent access", () => {
      const element = document.createElement("div");
      element.id = "cached-element";
      document.body.appendChild(element);

      const first = domCache.get("cached-element");
      const second = domCache.get("cached-element");

      expect(first).toBe(second);
      expect(first).toBe(element);
    });

    it("invalidates cache when element is removed from DOM", () => {
      const element = document.createElement("div");
      element.id = "removable";
      document.body.appendChild(element);

      domCache.get("removable");
      expect(domCache.has("removable")).toBe(true);

      // Remove element from DOM
      document.body.removeChild(element);

      const result = domCache.get("removable");

      expect(result).toBeNull();
      expect(domCache.has("removable")).toBe(false);
    });

    it("re-caches element if it's added back after removal", () => {
      const element1 = document.createElement("div");
      element1.id = "replaceable";
      document.body.appendChild(element1);

      domCache.get("replaceable");
      document.body.removeChild(element1);
      domCache.get("replaceable"); // Triggers cache invalidation

      const element2 = document.createElement("div");
      element2.id = "replaceable";
      document.body.appendChild(element2);

      const result = domCache.get("replaceable");

      expect(result).toBe(element2);
      expect(result).not.toBe(element1);
    });
  });

  describe("cacheElements", () => {
    it("caches multiple elements at once", () => {
      const el1 = document.createElement("div");
      el1.id = "element-1";
      const el2 = document.createElement("div");
      el2.id = "element-2";
      const el3 = document.createElement("div");
      el3.id = "element-3";

      document.body.appendChild(el1);
      document.body.appendChild(el2);
      document.body.appendChild(el3);

      domCache.cacheElements(["element-1", "element-2", "element-3"]);

      expect(domCache.has("element-1")).toBe(true);
      expect(domCache.has("element-2")).toBe(true);
      expect(domCache.has("element-3")).toBe(true);
      expect(domCache.size).toBe(3);
    });

    it("skips non-existent elements", () => {
      const el1 = document.createElement("div");
      el1.id = "exists";
      document.body.appendChild(el1);

      domCache.cacheElements(["exists", "does-not-exist", "also-missing"]);

      expect(domCache.has("exists")).toBe(true);
      expect(domCache.has("does-not-exist")).toBe(false);
      expect(domCache.has("also-missing")).toBe(false);
      expect(domCache.size).toBe(1);
    });

    it("handles empty array", () => {
      domCache.cacheElements([]);

      expect(domCache.size).toBe(0);
    });
  });

  describe("clear", () => {
    it("removes all cached elements", () => {
      const el1 = document.createElement("div");
      el1.id = "element-1";
      const el2 = document.createElement("div");
      el2.id = "element-2";

      document.body.appendChild(el1);
      document.body.appendChild(el2);

      domCache.cacheElements(["element-1", "element-2"]);
      expect(domCache.size).toBe(2);

      domCache.clear();

      expect(domCache.size).toBe(0);
      expect(domCache.has("element-1")).toBe(false);
      expect(domCache.has("element-2")).toBe(false);
    });

    it("allows re-caching after clear", () => {
      const element = document.createElement("div");
      element.id = "clearable";
      document.body.appendChild(element);

      domCache.get("clearable");
      domCache.clear();

      const result = domCache.get("clearable");

      expect(result).toBe(element);
      expect(domCache.size).toBe(1);
    });
  });

  describe("remove", () => {
    it("removes specific element from cache", () => {
      const el1 = document.createElement("div");
      el1.id = "keep";
      const el2 = document.createElement("div");
      el2.id = "remove";

      document.body.appendChild(el1);
      document.body.appendChild(el2);

      domCache.cacheElements(["keep", "remove"]);
      expect(domCache.size).toBe(2);

      domCache.remove("remove");

      expect(domCache.has("keep")).toBe(true);
      expect(domCache.has("remove")).toBe(false);
      expect(domCache.size).toBe(1);
    });

    it("handles removing non-existent key", () => {
      domCache.remove("non-existent");

      expect(domCache.size).toBe(0);
    });
  });

  describe("has", () => {
    it("returns true for cached elements", () => {
      const element = document.createElement("div");
      element.id = "exists";
      document.body.appendChild(element);

      domCache.get("exists");

      expect(domCache.has("exists")).toBe(true);
    });

    it("returns false for non-cached elements", () => {
      expect(domCache.has("not-cached")).toBe(false);
    });
  });

  describe("size", () => {
    it("returns correct cache size", () => {
      expect(domCache.size).toBe(0);

      const el1 = document.createElement("div");
      el1.id = "element-1";
      document.body.appendChild(el1);
      domCache.get("element-1");

      expect(domCache.size).toBe(1);

      const el2 = document.createElement("div");
      el2.id = "element-2";
      document.body.appendChild(el2);
      domCache.get("element-2");

      expect(domCache.size).toBe(2);

      domCache.remove("element-1");

      expect(domCache.size).toBe(1);

      domCache.clear();

      expect(domCache.size).toBe(0);
    });
  });

  describe("performance benefits", () => {
    it("reduces DOM queries for frequently accessed elements", () => {
      const element = document.createElement("div");
      element.id = "frequent";
      document.body.appendChild(element);

      // First access - queries DOM and caches
      const result1 = domCache.get("frequent");

      // Subsequent accesses use cache
      const result2 = domCache.get("frequent");
      const result3 = domCache.get("frequent");
      const result4 = domCache.get("frequent");

      expect(result1).toBe(element);
      expect(result2).toBe(element);
      expect(result3).toBe(element);
      expect(result4).toBe(element);

      // All access the same cached reference
      expect(result1).toBe(result2);
      expect(result2).toBe(result3);
      expect(result3).toBe(result4);
    });
  });
});
