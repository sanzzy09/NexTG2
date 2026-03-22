// indosmm.js - Wrapper untuk API indosmm.id
const https = require('https');

class IndosmmAPI {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://indosmm.id/api/v2';
  }

  async request(action, params = {}) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({
        key: this.apiKey,
        action,
        ...params
      });

      const url = new URL(this.baseUrl);
      const options = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': payload.length
        }
      };

      const req = https.request(url, options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve(json);
          } catch (e) {
            reject(new Error(`Invalid JSON: ${data}`));
          }
        });
      });

      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  // Get list of services
  async getServices() {
    return this.request('services');
  }

  // Create order
  // params: { service: number, link: string, quantity: number }
  async addOrder(service, link, quantity) {
    return this.request('add', { service, link, quantity });
  }

  // Check order status
  // params: { order: number } or { orders: "1,2,3" }
  async getStatus(orderId) {
    return this.request('status', { order: orderId });
  }

  // Multiple orders status
  async getMultipleStatus(orderIds) {
    return this.request('status', { orders: orderIds.join(',') });
  }
}

module.exports = IndosmmAPI;
