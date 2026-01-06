// Optional: small module to wrap Pterodactyl API calls (used by server.js)
const axios = require('axios');

class PterodactylClient {
  constructor({ baseUrl, adminKey }) {
    this.baseUrl = baseUrl;
    this.adminKey = adminKey;
    this.client = axios.create({
      baseURL: baseUrl + '/api/application',
      headers: { Authorization: `Bearer ${adminKey}`, Accept: 'application/json' }
    });
  }

  async createServer(payload) {
    const res = await this.client.post('/servers', payload);
    return res.data;
  }

  async getServer(id) {
    const res = await this.client.get(`/servers/${id}`);
    return res.data;
  }

  async powerAction(serverId, signal) {
    // signal: start, stop, restart
    return this.client.post(`/servers/${serverId}/power`, { signal });
  }
}

module.exports = PterodactylClient;