let messageFormatter= (username,text)=>{
    return {
        username,
        text,
        time: new Date().toLocaleTimeString()
    }
}

module.exports = messageFormatter;