'use strict';

const mysql = require('mysql');
//const config = require('config');
const dotenv = require('dotenv');
dotenv.config();

class Db {
	constructor() {

		this.connection = mysql.createPool({
			connectionLimit: 100,
			host: process.env.DBHOST,
            // socketPath: process.env.DBSOCKETPATH,
			user: process.env.DBUSERNAME,
			password: process.env.DBPASSWORD,
			database: process.env.DATABASE,
			debug: false
		});
	}
	query(sql, args) {
		return new Promise((resolve, reject) => {
			this.connection.query(sql, args, (err, rows) => {
				if (err)
					return reject(err);
				resolve(rows);
			});
		});
	}
	close() {
		return new Promise((resolve, reject) => {
			this.connection.end(err => {
				if (err)
					return reject(err);
				resolve();
			});
		});
	}
}
module.exports = new Db();
