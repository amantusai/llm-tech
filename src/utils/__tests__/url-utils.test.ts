import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isValidDocumentationUrl,
  getSupportedDomainsText,
  extractUrlFromQueryString,
  updateUrlWithDocumentation,
  generateFilename,
} from '../url-utils';

describe('url-utils', () => {
  describe('isValidDocumentationUrl', () => {
    it('should validate Apple Developer URLs', () => {
      expect(isValidDocumentationUrl('https://developer.apple.com/documentation/swiftui')).toBe(
        true
      );
      expect(
        isValidDocumentationUrl('https://developer.apple.com/documentation/uikit/uiview')
      ).toBe(true);
      expect(isValidDocumentationUrl('https://developer.apple.com')).toBe(true);
    });

    it('should validate Swift Package Index URLs', () => {
      expect(
        isValidDocumentationUrl(
          'https://swiftpackageindex.com/pointfreeco/swift-composable-architecture'
        )
      ).toBe(true);
      expect(isValidDocumentationUrl('https://swiftpackageindex.com/vapor/vapor')).toBe(true);
    });

    it('should validate GitHub Pages URLs', () => {
      expect(
        isValidDocumentationUrl('https://pointfreeco.github.io/swift-composable-architecture/')
      ).toBe(true);
      expect(isValidDocumentationUrl('https://vapor-community.github.io/vapor-websocket/')).toBe(
        true
      );
    });

    it('should reject invalid URLs', () => {
      expect(isValidDocumentationUrl('')).toBe(false);
      expect(isValidDocumentationUrl('https://github.com/user/repo')).toBe(false);
      expect(isValidDocumentationUrl('https://google.com')).toBe(false);
      expect(isValidDocumentationUrl('not-a-url')).toBe(false);
    });
  });

  describe('getSupportedDomainsText', () => {
    it('should return formatted domain count', () => {
      expect(getSupportedDomainsText()).toBe('70 supported documentation sites');
    });
  });

  describe('extractUrlFromQueryString', () => {
    it('should extract URL from query string', () => {
      expect(extractUrlFromQueryString('https://developer.apple.com/documentation/swiftui')).toBe(
        'https://developer.apple.com/documentation/swiftui'
      );
      // Test URL-encoded input - should decode and return the URL
      const encoded = encodeURIComponent('https://developer.apple.com/documentation/swiftui');
      expect(extractUrlFromQueryString(encoded)).toBe(
        'https://developer.apple.com/documentation/swiftui'
      );
    });

    it('should return null for non-URL query strings', () => {
      expect(extractUrlFromQueryString('')).toBe(null);
      expect(extractUrlFromQueryString('random-string')).toBe(null);
      expect(extractUrlFromQueryString('key=value')).toBe(null);
    });
  });

  describe('updateUrlWithDocumentation', () => {
    beforeEach(() => {
      window.history.replaceState = vi.fn();
      window.location.pathname = '/';
    });

    it('should update browser URL with documentation URL', () => {
      const url = 'https://developer.apple.com/documentation/swiftui';
      updateUrlWithDocumentation(url);

      expect(window.history.replaceState).toHaveBeenCalledWith(
        {},
        '',
        `/?${encodeURIComponent(url)}`
      );
    });

    it('should not update URL if empty', () => {
      updateUrlWithDocumentation('');
      expect(window.history.replaceState).not.toHaveBeenCalled();
    });
  });

  describe('generateFilename', () => {
    beforeEach(() => {
      // Mock the current date to ensure consistent test results
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2025-06-14'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });
    it('should generate Apple Developer filenames with date prefix', () => {
      expect(generateFilename('https://developer.apple.com/documentation/swiftui')).toBe(
        '2025-06-14_apple-developer-documentation-swiftui-docs.md'
      );
      expect(generateFilename('https://developer.apple.com/documentation/uikit/uiview')).toBe(
        '2025-06-14_apple-developer-documentation-uikit-docs.md'
      );
      expect(generateFilename('https://developer.apple.com/documentation/')).toBe(
        '2025-06-14_apple-developer-documentation-docs.md'
      );
    });

    it('should generate Swift Package Index filenames with date prefix', () => {
      expect(
        generateFilename('https://swiftpackageindex.com/pointfreeco/swift-composable-architecture')
      ).toBe('2025-06-14_swift-package-index-pointfreeco-swift-composable-architecture-docs.md');
      expect(generateFilename('https://swiftpackageindex.com/vapor/vapor')).toBe(
        '2025-06-14_swift-package-index-vapor-vapor-docs.md'
      );
      expect(generateFilename('https://swiftpackageindex.com/')).toBe(
        '2025-06-14_swift-package-index-docs.md'
      );
    });

    it('should generate GitHub Pages filenames with date prefix', () => {
      expect(generateFilename('https://pointfreeco.github.io/swift-composable-architecture/')).toBe(
        '2025-06-14_github-pages----github-io--swift-composable-architecture-docs.md'
      );
      expect(
        generateFilename(
          'https://pointfreeco.github.io/swift-composable-architecture/documentation/composablearchitecture'
        )
      ).toBe('2025-06-14_github-pages----github-io--swift-composable-architecture-documentation-docs.md');
      expect(generateFilename('https://example.github.io/')).toBe(
        '2025-06-14_github-pages----github-io--docs.md'
      );
    });

    it('should handle invalid URLs gracefully with date prefix', () => {
      expect(generateFilename('not-a-url')).toBe('2025-06-14_documentation.md');
      expect(generateFilename('')).toBe('2025-06-14_documentation.md');
    });

    it('should handle other domains with date prefix', () => {
      expect(generateFilename('https://example.com/docs/api')).toBe('2025-06-14_example-com-docs-docs.md');
      expect(generateFilename('https://example.com/')).toBe('2025-06-14_example-com-docs.md');
    });

    it('should use correct ISO 8601 date format', () => {
      // Test different dates to ensure proper formatting
      vi.setSystemTime(new Date('2025-01-01'));
      expect(generateFilename('https://example.com/')).toBe('2025-01-01_example-com-docs.md');
      
      vi.setSystemTime(new Date('2025-12-31'));
      expect(generateFilename('https://example.com/')).toBe('2025-12-31_example-com-docs.md');
      
      // Test with single digit month and day
      vi.setSystemTime(new Date('2025-03-05'));
      expect(generateFilename('https://example.com/')).toBe('2025-03-05_example-com-docs.md');
    });
  });
});
