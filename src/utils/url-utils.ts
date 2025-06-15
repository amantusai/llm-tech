import { ALLOWED_DOMAINS } from '@/constants';

export function isValidDocumentationUrl(url: string): boolean {
  if (!url) return false;

  // Check each allowed domain
  return Object.values(ALLOWED_DOMAINS).some((domain) => {
    if (typeof domain.pattern === 'string') {
      return url.startsWith(domain.pattern);
    } else if (typeof domain.pattern === 'object' && domain.pattern instanceof RegExp) {
      return domain.pattern.test(url);
    }
    return false;
  });
}

export function getSupportedDomainsText(): string {
  const domainCount = Object.keys(ALLOWED_DOMAINS).length;
  return `${domainCount} supported documentation sites`;
}

export function extractUrlFromQueryString(queryString: string): string | null {
  if (!queryString) return null;

  // Try to decode first in case it's URL-encoded
  const decoded = decodeURIComponent(queryString);

  // Check if it looks like a URL (starts with http)
  if (decoded.startsWith('http://') || decoded.startsWith('https://')) {
    return decoded;
  }

  return null;
}

export function updateUrlWithDocumentation(url: string): void {
  if (!url) return;

  // Update the URL without reloading the page
  const newUrl = `${window.location.pathname}?${encodeURIComponent(url)}`;
  window.history.replaceState({}, '', newUrl);
}

export function normalizeUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    // Remove fragment and query parameters
    urlObj.hash = '';
    urlObj.search = '';
    // Remove trailing slash if it's not the root path
    let normalized = urlObj.toString();
    if (normalized.endsWith('/') && urlObj.pathname !== '/') {
      normalized = normalized.slice(0, -1);
    }
    return normalized;
  } catch {
    return url;
  }
}

export function generateFilename(url: string): string {
  // Get current date in YYYY-MM-DD format (ISO 8601)
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const datePrefix = `${year}-${month}-${day}_`;

  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname;
    const pathname = urlObj.pathname;

    // Find the matching domain configuration
    const matchedDomain = Object.values(ALLOWED_DOMAINS).find((domain) => {
      if (typeof domain.pattern === 'string') {
        return url.startsWith(domain.pattern);
      } else if (typeof domain.pattern === 'object' && domain.pattern instanceof RegExp) {
        return domain.pattern.test(url);
      }
      return false;
    });

    if (matchedDomain) {
      // Use the domain name as a base for the filename
      const baseName = matchedDomain.name.toLowerCase().replace(/[^a-z0-9]/g, '-');
      const pathParts = pathname.split('/').filter((p) => p && p.length > 0);

      if (pathParts.length > 0) {
        // Take up to 2 path parts for the filename
        const pathSuffix = pathParts.slice(0, 2).join('-');
        return `${datePrefix}${baseName}-${pathSuffix}-docs.md`;
      }
      return `${datePrefix}${baseName}-docs.md`;
    }

    // Fallback: use the hostname and any path
    const pathParts = pathname.split('/').filter((p) => p);
    if (pathParts.length > 0) {
      return `${datePrefix}${hostname.replace(/\./g, '-')}-${pathParts[0]}-docs.md`;
    }
    return `${datePrefix}${hostname.replace(/\./g, '-')}-docs.md`;
  } catch {
    return `${datePrefix}documentation.md`;
  }
}
