/**
 * Xget - High-performance acceleration engine for developer resources
 * Copyright (C) Xi Xu
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * Hugging Face protocol handler for Xget
 */

/**
 * Detects if a request is a Hugging Face API operation.
 *
 * Identifies Hugging Face API requests by checking for:
 * - Hugging Face platform prefix (/hf/)
 * - API path segment (/api/)
 * @param {Request} request - The incoming request object
 * @param {URL} url - Parsed URL object
 * @returns {boolean} True if this is a Hugging Face API operation
 */
export function isHuggingFaceAPIRequest(request, url) {
  // Check for Hugging Face API endpoints
  if (url.pathname.startsWith('/hf/api/')) {
    return true;
  }

  // Also check for token endpoint which is often used
  if (url.pathname.startsWith('/hf/token')) {
    return true;
  }

  return false;
}

/**
 * Configures headers for Hugging Face API requests.
 * @param {Headers} headers - The headers object to modify
 * @param {Request} request - The original request
 */
export function configureHuggingFaceHeaders(headers, request) {
  const authHeader = request.headers.get('Authorization');
  if (authHeader) {
    headers.set('Authorization', authHeader);
  }

  if (request.method === 'POST' && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
}

/**
 * Follows file redirects while retaining the Hub metadata required by its SDK.
 * @param {string} targetUrl - Hub resolve URL
 * @param {RequestInit} fetchOptions - Upstream options, including method and range
 * @returns {Promise<Response>} Streamed file response with Hub metadata
 */
export async function fetchHuggingFaceFile(targetUrl, fetchOptions) {
  const metadata = new Headers();
  let currentUrl = new URL(targetUrl);
  const headers = new Headers(fetchOptions.headers);
  /** @type {RequestInit} */
  const options = { ...fetchOptions, redirect: 'manual' };

  // Cloudflare can serve a cached GET for HEAD; metadata must come from the Hub.
  if (fetchOptions.method === 'HEAD') {
    Object.assign(options, { cf: { cacheTtl: -1, cacheEverything: false } });
  }

  for (let redirects = 0; ; redirects++) {
    const response = await fetch(currentUrl.toString(), {
      ...options,
      headers: new Headers(headers)
    });

    if (![301, 302, 303, 307, 308].includes(response.status)) {
      if (!response.ok || metadata.keys().next().done) {
        return response;
      }

      const responseHeaders = new Headers(response.headers);
      for (const [key, value] of metadata) {
        responseHeaders.set(key, value);
      }
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders
      });
    }

    const location = response.headers.get('Location');
    if (!location) {
      return response;
    }

    for (const key of ['X-Repo-Commit', 'X-Linked-Etag', 'X-Linked-Size']) {
      const value = response.headers.get(key);
      if (value !== null && !metadata.has(key)) {
        metadata.set(key, value);
      }
    }

    await response.body?.cancel();
    if (redirects >= 20) {
      throw new Error('Too many Hugging Face file redirects');
    }

    const nextUrl = new URL(location, currentUrl);
    if (nextUrl.origin !== currentUrl.origin) {
      headers.delete('Authorization');
      headers.delete('Cookie');
      headers.delete('Proxy-Authorization');
    }
    currentUrl = nextUrl;
  }
}
