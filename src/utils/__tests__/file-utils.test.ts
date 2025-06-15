import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { downloadMarkdown } from '../file-utils';

// Mock document methods
const mockCreateElement = vi.fn();
const mockAppendChild = vi.fn();
const mockRemoveChild = vi.fn();
const mockClick = vi.fn();

// Mock URL methods
const mockCreateObjectURL = vi.fn();
const mockRevokeObjectURL = vi.fn();

describe('file-utils', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    
    // Mock the current date to ensure consistent test results
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-06-14'));

    // Setup document mocks
    mockCreateElement.mockReturnValue({
      click: mockClick,
      href: '',
      download: '',
    });

    document.createElement = mockCreateElement;
    document.body.appendChild = mockAppendChild;
    document.body.removeChild = mockRemoveChild;

    // Setup URL mocks
    mockCreateObjectURL.mockReturnValue('blob:mock-url');

    global.URL.createObjectURL = mockCreateObjectURL;
    global.URL.revokeObjectURL = mockRevokeObjectURL;

    // Mock Blob
    global.Blob = vi.fn().mockImplementation((content, options) => ({
      size: content[0].length,
      type: options.type,
    })) as unknown as typeof Blob;
  });
  
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('downloadMarkdown', () => {
    const mockResults = [
      { url: 'https://example.com/page1', content: 'Content 1' },
      { url: 'https://example.com/page2', content: 'Content 2' },
      { url: 'https://example.com/page3', content: '' },
    ];

    it('should download markdown with all filters disabled', () => {
      downloadMarkdown({
        url: 'https://example.com',
        results: mockResults,
        filterUrls: false,
        deduplicateContent: false,
        filterAvailability: false,
      });

      // Check that Blob was created with correct content
      expect(global.Blob).toHaveBeenCalled();
      const blobContent = vi.mocked(global.Blob).mock.calls[0]?.[0]?.[0] as string;
      expect(blobContent).toContain('Downloaded via https://llm.codes');
      expect(blobContent).toContain('Source URL: https://example.com');
      expect(blobContent).toContain('Total pages processed: 3');
      expect(blobContent).toContain('Pages with content: 2');
      expect(blobContent).toContain('Content 1');
      expect(blobContent).toContain('Content 2');
      expect(blobContent).not.toContain('https://example.com/page3'); // Empty content filtered

      // Check download was triggered
      expect(mockClick).toHaveBeenCalled();
      expect(mockCreateObjectURL).toHaveBeenCalled();
      expect(mockRevokeObjectURL).toHaveBeenCalled();
    });

    it('should apply URL filtering when enabled', () => {
      const resultsWithUrls = [
        {
          url: 'https://example.com/page1',
          content: 'Check [this link](https://example.com) for more info.',
        },
      ];

      downloadMarkdown({
        url: 'https://example.com',
        results: resultsWithUrls,
        filterUrls: true,
        deduplicateContent: false,
        filterAvailability: false,
      });

      const blobContent = vi.mocked(global.Blob).mock.calls[0]?.[0]?.[0] as string;
      expect(blobContent).toContain('Check this link for more info.');
      expect(blobContent).not.toContain('[this link](https://example.com)');
    });

    it('should apply availability filtering when enabled', () => {
      const resultsWithAvailability = [
        {
          url: 'https://example.com/page1',
          content: 'iOS 14.0+iPadOS 14.0+ This feature is available',
        },
      ];

      downloadMarkdown({
        url: 'https://example.com',
        results: resultsWithAvailability,
        filterUrls: false,
        deduplicateContent: false,
        filterAvailability: true,
      });

      const blobContent = vi.mocked(global.Blob).mock.calls[0]?.[0]?.[0] as string;
      expect(blobContent).toContain('This feature is available');
      expect(blobContent).not.toContain('iOS 14.0+');
    });

    it('should apply deduplication when enabled', () => {
      const resultsWithDuplicates = [
        {
          url: 'https://example.com/page1',
          content: 'Duplicate content\n\nUnique content\n\nDuplicate content',
        },
      ];

      downloadMarkdown({
        url: 'https://example.com',
        results: resultsWithDuplicates,
        filterUrls: false,
        deduplicateContent: true,
        filterAvailability: false,
      });

      const blobContent = vi.mocked(global.Blob).mock.calls[0]?.[0]?.[0] as string;
      // Should only contain duplicate content once
      const duplicateMatches = blobContent?.match(/Duplicate content/g);
      expect(duplicateMatches).toHaveLength(1);
      expect(blobContent).toContain('Unique content');
    });

    it('should generate correct filename for Apple docs', () => {
      downloadMarkdown({
        url: 'https://developer.apple.com/documentation/swiftui',
        results: mockResults,
        filterUrls: false,
        deduplicateContent: false,
        filterAvailability: false,
      });

      const anchorElement = mockCreateElement.mock.results[0].value;
      expect(anchorElement.download).toBe('2025-06-14_apple-developer-documentation-swiftui-docs.md');
    });

    it('should generate correct filename for Swift Package Index', () => {
      downloadMarkdown({
        url: 'https://swiftpackageindex.com/vapor/vapor',
        results: mockResults,
        filterUrls: false,
        deduplicateContent: false,
        filterAvailability: false,
      });

      const anchorElement = mockCreateElement.mock.results[0].value;
      expect(anchorElement.download).toBe('2025-06-14_swift-package-index-vapor-vapor-docs.md');
    });

    it('should generate correct filename for GitHub Pages', () => {
      downloadMarkdown({
        url: 'https://pointfreeco.github.io/swift-composable-architecture/',
        results: mockResults,
        filterUrls: false,
        deduplicateContent: false,
        filterAvailability: false,
      });

      const anchorElement = mockCreateElement.mock.results[0].value;
      expect(anchorElement.download).toBe('2025-06-14_github-pages----github-io--swift-composable-architecture-docs.md');
    });

    it('should handle results with only empty content', () => {
      const emptyResults = [
        { url: 'https://example.com/page1', content: '' },
        { url: 'https://example.com/page2', content: '   ' },
      ];

      downloadMarkdown({
        url: 'https://example.com',
        results: emptyResults,
        filterUrls: false,
        deduplicateContent: false,
        filterAvailability: false,
      });

      const blobContent = vi.mocked(global.Blob).mock.calls[0]?.[0]?.[0] as string;
      expect(blobContent).toContain('Pages with content: 0');
      expect(blobContent).not.toContain('# https://example.com/page1');
      expect(blobContent).not.toContain('# https://example.com/page2');
    });
  });
});
