/*
*	Invoke the Oracle procedure and return the raw content of the page
*/

import oracledb from 'oracledb';
import {streamToBuffer} from './stream';
import {uploadFiles, filesUploadType} from './fileUpload';
import {parse, send} from './page';
import {ProcedureError} from './procedureError';
import {RequestError} from './requestError';
import {Trace} from './trace';
import express from 'express';
import {oracleExpressMiddleware$options} from './config';

type argObjType = { [key: string]: string | Array<string> };
type validResType = { outBinds?: { ret: number } | undefined };

/**
* Invoke the Oracle procedure and return the page content
*
* @param {express.Request} req - The req object represents the HTTP request.
* @param {express.Response} res - The res object represents the HTTP response that an Express app sends when it gets an HTTP request.
* @param {argObjType} argObj - - The arguments of the procedure to invoke.
* @param {Object} cgiObj - The cgi of the procedure to invoke.
* @param {filesUploadType} filesToUpload - Array of files to be uploaded
* @param {oracleExpressMiddleware$options} options - the options for the middleware.
* @param {oracledb.Connection} databaseConnection - Database connection.
* @param {Trace} trace - Tracing object.
* @returns {Promise<void>} - Promise resolving to the page content generated by the executed procedure
*/
export async function invokeProcedure(req: express.Request, res: express.Response, argObj: argObjType, cgiObj: Record<string, string>, filesToUpload: filesUploadType, options: oracleExpressMiddleware$options, databaseConnection: oracledb.Connection, trace: Trace): Promise<void> {
	trace.write('invokeProcedure: ENTER');

	const procedure = req.params.name;

	//
	// 1) UPLOAD FILES
	//

	trace.write(`invokeProcedure: upload "${filesToUpload.length}" files`);
	/* istanbul ignore else */
	if (typeof options.doctable === 'string' && options.doctable.length > 0) {
		uploadFiles(filesToUpload, options.doctable, databaseConnection);
	}

	//
	// 2) GET SQL STATEMENT AND ARGUMENTS
	//

	const para = await getProcedure(procedure, argObj, options, databaseConnection, trace);

	//
	// 3) Validate Procedure
	//
	let validOperation = false;
	try {
		const validationFunction = options.requestValidation || false;
		if (validationFunction) {
			// validate here
			const query = `DECLARE
		a boolean;
		ret number;
    BEGIN
        a := ${validationFunction}(:proc);
		:ret := case when a then 1 else 0 end;
    END;`;

			const requestValidRes:validResType = await databaseConnection.execute(
				query,
				{
					proc: procedure,
					ret: {dir: oracledb.BIND_OUT, type: oracledb.NUMBER},
				}
			);

			validOperation = requestValidRes.outBinds && requestValidRes.outBinds.ret ? requestValidRes.outBinds.ret === 1 : false;
		} else {
			validOperation = true;
		}
	} catch (error) {
		trace.write(error instanceof Error ? error.toString() : '');
		throw new Error('Error during the validation of the procedure (RequestValidationFunction)');
	}

	//
	//	4) EXECUTE PROCEDURE
	//

	const HTBUF_LEN = 63;
	const MAX_IROWS = 100000;

	const cgi = {
		keys: Object.keys(cgiObj),
		values: Object.values(cgiObj)
	};

	const fileBlob = await databaseConnection.createLob(oracledb.BLOB);

	const bind = {
		cgicount: {dir: oracledb.BIND_IN, type: oracledb.NUMBER, val: cgi.keys.length},
		cginames: {dir: oracledb.BIND_IN, type: oracledb.STRING, val: cgi.keys},
		cgivalues: {dir: oracledb.BIND_IN, type: oracledb.STRING, val: cgi.values},
		htbuflen: {dir: oracledb.BIND_IN, type: oracledb.NUMBER, val: HTBUF_LEN},
		fileType: {dir: oracledb.BIND_OUT, type: oracledb.STRING},
		fileSize: {dir: oracledb.BIND_OUT, type: oracledb.NUMBER},
		fileBlob: {dir: oracledb.BIND_INOUT, type: oracledb.BLOB, val: fileBlob},
		lines: {dir: oracledb.BIND_OUT, type: oracledb.STRING, maxSize: HTBUF_LEN * 2, maxArraySize: MAX_IROWS},
		irows: {dir: oracledb.BIND_INOUT, type: oracledb.NUMBER, val: MAX_IROWS}
	};

	// execute procedure and retrieve page
	const sqlStatement = getProcedureSQL(para.sql);
	let result: any;
	try {
		if (validOperation === true) {
			trace.write(`execute:\n${'-'.repeat(30)}\n${sqlStatement}\n${'-'.repeat(30)}\nwith bindings:\n${Trace.inspect(bind)}`);
			result = await databaseConnection.execute(sqlStatement, Object.assign(bind, para.bind));
			trace.write(`results:\n${Trace.inspect(result)}`);
		} else {
			result = {
				outBinds: {
					lines: ['No access to this.'],
					fileBlob: null,
					fileType: null,
					fileSize: null
				}
			};
		}
	} catch (err) {
		trace.write(err instanceof Error ? err.toString() : '');
		/* istanbul ignore next */
		throwError(`Error when executing procedure\n${sqlStatement}\n${err instanceof Error ? err.toString() : ''}`, para, cgiObj, trace);
	}

	//
	//	5) PROCESS RESULTS
	//

	// internal error
	if (!result) {
		trace.write('Error when retrieving rows');
		/* istanbul ignore next */
		throwError('Error when retrieving rows', para, cgiObj, trace);
	}

	// Make sure that we have retrieved all the rows
	if (result.outBinds.irows > MAX_IROWS) {
		trace.write(`Error when retrieving rows. irows="${result.outBinds.irows}"`);
		/* istanbul ignore next */
		throwError(`Error when retrieving rows. irows="${result.outBinds.irows}"`, para, cgiObj, trace);
	}

	// combine page
	const pageContent = result.outBinds.lines.join('');
	trace.write(`PLAIN CONTENT:\n${'-'.repeat(30)}\n${pageContent}\n${'-'.repeat(30)}`);

	//
	//	6) PARSE PAGE
	//

	// parse what we received from PL/SQL
	const pageComponents = parse(pageContent);

	// add "Server" header
	pageComponents.head.server = cgiObj.SERVER_SOFTWARE;

	// add file download information
	pageComponents.file.fileType = result.outBinds.fileType;
	pageComponents.file.fileSize = result.outBinds.fileSize;
	pageComponents.file.fileBlob = result.outBinds.fileBlob !== null ? await streamToBuffer(result.outBinds.fileBlob) : null;

	trace.write(`PARSED CONTENT:\n${'-'.repeat(30)}\n${Trace.inspect(pageComponents)}\n${'-'.repeat(30)}`);

	//
	//	7) SEND THE RESPONSE
	//

	send(req, res, pageComponents, trace);

	//
	//	8) CLEANUP
	//

	await fileBlob.close();

	trace.write('invokeProcedure: EXIT');

	return Promise.resolve();
}

/*
* Report error in procedure
*/
/* istanbul ignore next */
function throwError(error: string, para: { sql: string; bind: any }, cgiObj: any, trace: Trace) {
	/* istanbul ignore next */
	trace.write(error);
	/* istanbul ignore next */
	throw new ProcedureError(error, cgiObj, para.sql, para.bind);
}

/*
*	Get the procedure and arguments to execute
*/
async function getProcedure(procedure: string, argObj: argObjType, options: oracleExpressMiddleware$options, databaseConnection: oracledb.Connection, trace: Trace): Promise<{ sql: string; bind: any }> {
	if (options.pathAlias && options.pathAlias.alias === procedure) {
		trace.write(`getProcedure: path alias "${options.pathAlias.alias}" redirects to "${options.pathAlias.procedure}"`);
		return Promise.resolve({
			sql: options.pathAlias.procedure + '(p_path=>:p_path);',
			bind: {
				'p_path': {dir: oracledb.BIND_IN, type: oracledb.STRING, val: procedure}
			}
		});
	} else if (procedure.substring(0, 1) === '!') {
		trace.write('getProcedure: get variable arguments');
		return getVarArgsPara(procedure, argObj);
	}

	trace.write('getProcedure: get named arguments');
	return getFixArgsPara(procedure, argObj, databaseConnection);
}

/*
* Get the SQL statement to execute when a new procedure is invoked
*/
function getProcedureSQL(procedure: string): string {
	return `
DECLARE
	fileType VARCHAR2(32767);
	fileSize INTEGER;
	fileBlob BLOB;
BEGIN
	-- Ensure a stateless environment by resetting package state (dbms_session.reset_package)
	dbms_session.modify_package_state(dbms_session.reinitialize);

	-- initialize the cgi
	owa.init_cgi_env(:cgicount, :cginames, :cgivalues);

	-- initialize the htp package
	htp.init;

	-- set the HTBUF_LEN
	htp.HTBUF_LEN := :htbuflen;

	-- execute the procedure
	BEGIN
		${procedure}
	EXCEPTION WHEN OTHERS THEN
		raise_application_error(-20000, 'Error executing ${procedure}'||CHR(10)||SUBSTR(dbms_utility.format_error_stack()||CHR(10)||dbms_utility.format_error_backtrace(), 1, 2000));
	END;

	-- Check for file download
	IF (wpg_docload.is_file_download()) THEN
		wpg_docload.get_download_file(fileType);
		IF (filetype = 'B') THEN
			wpg_docload.get_download_blob(:fileBlob);
			fileSize := dbms_lob.getlength(:fileBlob);
			--dbms_lob.copy(dest_lob=>:fileBlob, src_lob=>fileBlob, amount=>fileSize);
		END IF;
	END IF;
	:fileType := fileType;
	:fileSize := fileSize;

	-- retrieve the page
	owa.get_page(thepage=>:lines, irows=>:irows);
END;
`;
}

/*
* Get the sql statement and bindings for the procedure to execute for a variable number of arguments
*/
async function getVarArgsPara(procedure: string, argObj: argObjType): Promise<{ sql: string; bind: any }> {
	const names = [];
	const values = [];

	for (const key in argObj) {
		const value = argObj[key];
		if (typeof value === 'string') {
			names.push(key);
			values.push(value);
		} else if (Array.isArray(value)) {
			value.forEach(item => {
				names.push(key);
				values.push(item);
			});
		}
	}

	return Promise.resolve({
		sql: procedure.substring(1) + '(:argnames, :argvalues);',
		bind: {
			argnames: {dir: oracledb.BIND_IN, type: oracledb.STRING, val: names},
			argvalues: {dir: oracledb.BIND_IN, type: oracledb.STRING, val: values}
		}
	});
}

/*
* Get the sql statement and bindings for the procedure to execute for a fixed number of arguments
*/
async function getFixArgsPara(procedure: string, argObj: argObjType, databaseConnection: oracledb.Connection): Promise<{ sql: string; bind: any }> {
	const bind: { [key: string]: any } = {};
	let index = 0;

	const argTypes = await getArguments(procedure, databaseConnection);

	// bindings for the statement
	let sql = procedure + '(';
	for (const key in argObj) {
		const value = argObj[key];
		const parameterName = 'p_' + key;

		// prepend the separator, if this is not the first argument
		if (index > 0) {
			sql += ',';
		}
		index++;

		// add the argument
		sql += key + '=>:' + parameterName;

		// add the binding
		bind[parameterName] = {dir: oracledb.BIND_IN, type: oracledb.STRING};

		// set the value or array of values
		if (Array.isArray(value) || argTypes[key] === 'PL/SQL TABLE') {
			bind[parameterName].val = [];
			if (typeof value === 'string') {
				bind[parameterName].val.push(value);
			} else {
				value.forEach(element => {
					bind[parameterName].val.push(element);
				});
			}
		} else if (typeof value === 'string') {
			bind[parameterName].val = value;
		}
	}
	sql += ');';

	return Promise.resolve({
		sql: sql,
		bind: bind
	});
}

/*
*	Retrieve the argument types for a given procedure to be executed.
*	This is important because if the procedure is defined to take a PL/SQL indexed table,
*	we must provise a table, even if there is only one argument to be submitted.
*/
async function getArguments(procedure: string, databaseConnection: oracledb.Connection): Promise<{ [key: string]: string }> {
	const sql = [
		'DECLARE',
		'	schemaName		VARCHAR2(32767);',
		'	part1			VARCHAR2(32767);',
		'	part2			VARCHAR2(32767);',
		'	dblink			VARCHAR2(32767);',
		'	objectType		NUMBER;',
		'	objectID		NUMBER;',
		'BEGIN',
		'	dbms_utility.name_resolve(name=>UPPER(:name), context=>1, schema=>schemaName, part1=>part1, part2=>part2, dblink=>dblink, part1_type=>objectType, object_number=>objectID);',
		'	IF (part1 IS NOT NULL) THEN',
		'		SELECT argument_name, data_type BULK COLLECT INTO :names, :types FROM all_arguments WHERE owner = schemaName AND package_name = part1 AND object_name = part2 AND argument_name IS NOT NULL ORDER BY overload, sequence;',
		'	ELSE',
		'		SELECT argument_name, data_type BULK COLLECT INTO :names, :types FROM all_arguments WHERE owner = schemaName AND package_name IS NULL AND object_name = part2 AND argument_name IS NOT NULL ORDER BY overload, sequence;',
		'	END IF;',
		'END;'
	];
	const MAX_PARAMETER_NUMBER = 1000;

	const bind = {
		name: {dir: oracledb.BIND_IN, type: oracledb.STRING, val: procedure},
		names: {dir: oracledb.BIND_OUT, type: oracledb.STRING, maxSize: 60, maxArraySize: MAX_PARAMETER_NUMBER},
		types: {dir: oracledb.BIND_OUT, type: oracledb.STRING, maxSize: 60, maxArraySize: MAX_PARAMETER_NUMBER}
	};

	let result;

	try {
		result = await databaseConnection.execute<{ names: Array<string>; types: Array<string> }>(sql.join('\n'), bind);
	} catch (err) {
		/* istanbul ignore next */
		const message = `Error when retrieving arguments\n${sql.join('\n')}\n${err instanceof Error ? err.stack : ''}`;
		/* istanbul ignore next */
		throw new RequestError(message);
	}

	const argTypes: any = {};
	if (typeof result !== 'object' ||
		result === null ||
		typeof result.outBinds !== 'object' ||
		result.outBinds === null ||
		!Array.isArray(result.outBinds.names) ||
		!Array.isArray(result.outBinds.types)
	) {
		/* istanbul ignore next */
		throw new RequestError('getArguments: invalid results');
	}

	for (let i = 0; i < result.outBinds.names.length; i++) {
		/* istanbul ignore next */
		argTypes[result.outBinds.names[i].toLowerCase()] = result.outBinds.types[i];
	}

	return Promise.resolve(argTypes);
}
