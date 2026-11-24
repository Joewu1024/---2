import {getStore} from '@netlify/blobs';
import {createShareApi} from '../../lib/share-api.mjs';

const api = createShareApi({getStore});
export default request => api.publish(request);

export const config = {
  path: '/api/shares',
  rateLimit: {
    windowLimit: 60,
    windowSize: 60,
    aggregateBy: ['ip', 'domain']
  }
};
