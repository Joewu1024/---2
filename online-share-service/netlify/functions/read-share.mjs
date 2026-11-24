import {getStore} from '@netlify/blobs';
import {createShareApi} from '../../lib/share-api.mjs';

const api = createShareApi({getStore});
export default request => api.read(request);

export const config = {
  path: '/api/shares/:id',
  rateLimit: {
    windowLimit: 300,
    windowSize: 60,
    aggregateBy: ['ip', 'domain']
  }
};
