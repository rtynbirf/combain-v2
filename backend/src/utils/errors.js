class AppError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

function sendError(res, err) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: err.code, message: err.message });
  }
  console.error(err);
  return res.status(500).json({ error: 'INTERNAL', message: 'Internal server error' });
}

module.exports = { AppError, sendError };
