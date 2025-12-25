"user strict";

const DB = require("./db");
const path = require("path");
const fs = require("fs");
const axios = require("axios");

class Helper {
    constructor(app) {
        this.db = DB;
    }

    async addSocketId(userId, userSocketId, userToken) {
        try {
            const auth_response = await axios.post(
                process.env.APIURL + "/api/user/check-user-token",
                {socket_id:userSocketId},
                {
                    headers: {
                        Authorization: `Bearer ${userToken}`,
                    },
                }
            );
             await this.db.query(`INSERT INTO socket_ids SET socket_id = ?, user_id = ?`, [
                 userSocketId,
                 userId,
             ]);
            return auth_response.data.success;
        } catch (error) {
            console.log(error);
            return null;
        }
    }
    async logoutUser(userSocketId) {
        try {
            const logoutRes = await this.db.query(
                `UPDATE users SET socket_id = ? WHERE socket_id = ?`,
                [null, userSocketId]
            );
            return logoutRes;
        } catch (error) {
            console.log(error);
            return null;
        }
    }
}
module.exports = new Helper();
