// Set only after the owned persistence service is deployed and verified.
// An empty URL keeps the currently published self-contained direct links working.
// This file contains public routing configuration, never credentials.
(function (root) {
  'use strict';
  root.BUYER_SHARE_SERVICE = Object.freeze({ baseUrl: '' });
})(typeof globalThis !== 'undefined' ? globalThis : this);
