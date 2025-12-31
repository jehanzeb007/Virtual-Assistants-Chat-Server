'user strict';

const DB = require('./db');
const path = require('path');
const fs = require('fs');

class Helper{

    constructor(app){
        this.db = DB;
    }
    async addSocketId(userId, userSocketId){
    try {
        await this.db.query(`INSERT INTO user_socket_ids SET user_id=?,socket_id=?`, [userId,userSocketId]);
        //await this.db.query(`UPDATE users SET online= ? WHERE id = ?`, ['Y',userId]);
        return true;
    } catch (error) {

        console.log(error);
        return null;
    }
}

    async logoutUser(userSocketId){
        await this.db.query(`DELETE FROM user_socket_ids WHERE socket_id=?`, [userSocketId]);
        //await this.db.query(`UPDATE users SET online= ? WHERE socket_id = ?`, ['N',userSocketId]);
        return true;
}

    getChatList(userId){
        try {
            return Promise.all([
                    this.db.query(`SELECT id, name, updated_at FROM users WHERE id != ?`, [userId])
                ]).then( (response) => {
                    return {
                        chatlist : response[0]
                    };
        }).catch( (error) => {
                console.warn(error);
            return (null);
        });
        } catch (error) {
            console.warn(error);
            return null;
        }
    }

    async insertMessages(params){
    try {
        return await this.db.query("INSERT INTO messages (`message_id`, `type`, `file_format`, `file_path`, `from_user_id`,`to_user_id`,`message`, `date`, `time`, `ip`) values (?,?,?,?,?,?,?,?,?,?)", [params.message_id, params.type, params.fileFormat, params.filePath, params.fromUserId, params.toUserId, params.message, params.date, params.time,params.ip]
        );
    } catch (error) {
        console.warn(error);
        return null;
    }
}
    async updateMessagesRead(params){
    try {
        return await this.db.query("UPDATE messages SET is_read = '1' WHERE id = '"+params.id+"'");
    } catch (error) {
        console.warn(error);
        return null;
    }
}

    async getMessages(userId, toUserId){
    try {

        var messageData = await this.db.query(
            `SELECT id,id,message_id as messageId,is_read as isRead, from_user_id as fromUserId,to_user_id as toUserId,message,time,date,type,file_format as fileFormat,file_path as filePath FROM messages WHERE
					(from_user_id = ? AND to_user_id = ? )
					OR
					(from_user_id = ? AND to_user_id = ? )	ORDER BY id ASC
				`,
            [userId, toUserId, toUserId, userId]
        );
        //this.db.query("UPDATE messages SET is_read = '1' WHERE to_user_id = '"+userId+"' AND is_read = '0'");
        return messageData;
    } catch (error) {
        console.warn(error);
        return null;
    }
}

    async mkdirSyncRecursive(directory){
    var dir = directory.replace(/\/$/, '').split('/');
    for (var i = 1; i <= dir.length; i++) {
        var segment = path.basename('uploads') + "/" + dir.slice(0, i).join('/');
        !fs.existsSync(segment) ? fs.mkdirSync(segment) : null ;
    }
}
}
module.exports = new Helper();
