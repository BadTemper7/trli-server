import mongoose from 'mongoose';
import { AppError } from '../utils/http.js';

export function validateId(paramName = 'id') {
  if (typeof paramName !== 'string') paramName = 'id';
  return (req, res, next) => {
    const value = req.params[paramName];
    if (!mongoose.isValidObjectId(value)) return next(new AppError(`Invalid ${paramName}.`, 400));
    next();
  };
}
