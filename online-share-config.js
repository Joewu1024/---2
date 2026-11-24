(function (root) {
  'use strict';
  const config = Object.freeze({ serviceUrl: 'https://buyer-share-joewu1024.netlify.app' });
  if (typeof module === 'object' && module.exports) module.exports = config;
  else root.BuyerOnlineShareConfig = config;
})(typeof globalThis !== 'undefined' ? globalThis : this);
