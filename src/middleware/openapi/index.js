'use strict';

const _ = require('lodash');
const log = require('../../util/log');
const config = require('../../config');
const RequestSpecValidationError = require('./RequestSpecValidationError');

const OpenAPIRequestValidator = require('openapi-request-validator').default;
const OpenapiRequestCoercer = require('openapi-request-coercer').default;
const OpenAPIDefaultSetter = require('openapi-default-setter').default;
const OpenAPIResponseValidator = require('openapi-response-validator').default;

const spec = _.cloneDeep(require('../../api/openapi').spec);
resolveRefs(spec);

const transformError = ({id}, status) => error => ({
    id,
    status,
    code: error.errorCode,
    title: `${error.message} (location: ${error.location}, path: ${error.path})`
});

function findOperationById (spec, id) {
    return _(spec.paths).flatMap(value => _.values(value)).find(operation => operation.operationId === id);
}

function buildReqValidator (operation, parameters, spec) {
    return new OpenAPIRequestValidator({
        parameters,
        requestBody: operation.requestBody,
        componentSchemas: spec.components.schemas,
        version: '3',
        errorTransformer: null
    });
}

function buildResValidator (responses, spec) {
    return new OpenAPIResponseValidator({
        responses,
        components: spec.components
    });
}

function buildCoercer (parameters) {
    return new OpenapiRequestCoercer({ parameters });
}

function buildDefaulter (parameters) {
    return new OpenAPIDefaultSetter({ parameters });
}

function resolveRef (ref, spec) {
    const match = /^#\/components\/(.+)\/(.+)$/.exec(ref);

    if (!match || !_.has(spec.components[match[1]], match[2])) {
        throw new Error(`unknown $ref: ${ref}`);
    }

    return spec.components[match[1]][match[2]];
}

function resolveRefs (object, spec = object) {
    if (typeof object !== 'object' || object === null) {
        return;
    }

    Object.keys(object).forEach(key => {
        if (typeof object[key].$ref === 'string') {
            object[key] = resolveRef(object[key].$ref, spec);
        }

        resolveRefs(object[key], spec);
    });
}

module.exports = function (operationId) {
    const operation = findOperationById(spec, operationId);

    if (!operation) {
        throw new Error(`unknown operation id: ${operationId}`);
    }

    const parameters = operation.parameters || [];
    const responses = {
        default: spec.components.responses.ServerError, // implicitly add ServerError to every operation
        ...operation.responses
    };

    // TODO: this may be a bug in openapi
    parameters.forEach(parameter => {
        if (_.has(parameter.schema, 'default')) {
            parameter.default = parameter.schema.default;
        }
    });

    const reqValidator = buildReqValidator(operation, parameters, spec);
    const coercer = buildCoercer(parameters);
    const defaulter = buildDefaulter(parameters);

    const resValidator = buildResValidator(responses, spec);

    return function (req, res, next) {
        res.validateResponse = resValidator.validateResponse.bind(resValidator);
        const jsonFn = res.json.bind(res);
        res.json = function (...args) {
            const errors = resValidator.validateResponse(res.statusCode, args[0]);

            if (errors) {
                log.warn({ errors, body: args[0] }, 'response failed spec validation');

                if (config.validateResponseStrict) {
                    const status = 500;
                    const transformer = transformError(req, status);

                    res.status(status);
                    jsonFn({ errors: errors.errors.map(transformer) });
                }
            }

            return jsonFn(...args);
        };

        coercer.coerce(req);
        const errors = reqValidator.validate(req);

        if (errors) {
            const transformer = transformError(req, 400);
            return next(new RequestSpecValidationError(errors.errors.map(transformer)));
        }

        defaulter.handle(req);
        next();
    };
};
