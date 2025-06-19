const RequestQueue = require("../utils/requestQueue");

// Create a request queue instance with max 5 concurrent requests and 60 second timeout
const requestQueue = new RequestQueue(5, 60000);

function requestQueueMiddleware(req, res, next) {
  const requestHandler = () => {
    return new Promise((resolve, reject) => {
      // Store the original end method
      const originalEnd = res.end;

      // Override the end method to resolve the promise
      res.end = function (chunk, encoding) {
        res.end = originalEnd;
        res.end(chunk, encoding);
        resolve();
      };

      // Handle errors
      res.on("error", (err) => {
        reject(err);
      });

      // Continue with the request
      next();
    });
  };

  requestQueue.add(requestHandler).catch((error) => {
    if (error.message === "Request queue timeout") {
      res.status(503).json({
        error: "Service temporarily unavailable",
        message: "Request queue timeout - server is busy",
        queueLength: requestQueue.getQueueLength(),
        processingCount: requestQueue.getProcessingCount(),
      });
    } else {
      next(error);
    }
  });
}

module.exports = requestQueueMiddleware;
