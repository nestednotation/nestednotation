class RequestQueue {
  constructor(maxConcurrent = 10, queueTimeout = 30000) {
    this.queue = [];
    this.processing = 0;
    this.maxConcurrent = maxConcurrent;
    this.queueTimeout = queueTimeout;
  }

  async add(request) {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        const index = this.queue.findIndex((item) => item.request === request);
        if (index !== -1) {
          this.queue.splice(index, 1);
          reject(new Error("Request queue timeout"));
        }
      }, this.queueTimeout);

      this.queue.push({
        request,
        resolve,
        reject,
        timeoutId,
      });

      this.processQueue();
    });
  }

  async processQueue() {
    if (this.processing >= this.maxConcurrent || this.queue.length === 0) {
      return;
    }

    const { request, resolve, reject, timeoutId } = this.queue.shift();
    clearTimeout(timeoutId);
    this.processing++;

    try {
      const result = await request();
      resolve(result);
    } catch (error) {
      reject(error);
    } finally {
      this.processing--;
      this.processQueue();
    }
  }

  getQueueLength() {
    return this.queue.length;
  }

  getProcessingCount() {
    return this.processing;
  }
}

module.exports = RequestQueue;
