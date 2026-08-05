require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const mongoose = require('mongoose');
const { 
    initDB, User, Player, Team, Match, MatchPlayer, Rating, PlayerMatchStat 
} = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize database automatically on startup
initDB();

// Auto-start or timeout matches when their scheduled time arrives
setInterval(async () => {
    try {
        const now = new Date();
        const openMatches = await Match.find({ status: 'open' });
        
        for (let m of openMatches) {
            // Combine match_date and match_time for comparison
            const [timeStr, modifier] = m.match_time.split(' ');
            let [hours, minutes] = timeStr.split(':');
            if (hours === '12') hours = '00';
            if (modifier && modifier.toUpperCase() === 'PM') hours = parseInt(hours, 10) + 12;
            
            const matchDateTime = new Date(m.match_date);
            matchDateTime.setHours(hours, minutes, 0, 0);

            if (matchDateTime <= now) {
                const totalTeamA = await MatchPlayer.countDocuments({ match_id: m._id, team: 'A' });
                const totalTeamB = await MatchPlayer.countDocuments({ match_id: m._id, team: { $in: ['B', null] } });

                if (m.players_needed <= 0 && totalTeamA > 0 && totalTeamA === totalTeamB) {
                    m.status = 'started';
                } else {
                    m.status = 'timeout';
                }
                await m.save();
            }
        }
    } catch (err) {
        console.error('Error auto-processing matches:', err);
    }
}, 60000); // Check every minute

// Set EJS as templating engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Session Middleware
app.use(session({
    secret: 'khel_re_super_secret_key',
    resave: false,
    saveUninitialized: false
}));

// Make user available to all templates
app.use(async (req, res, next) => {
    if (req.session.user) {
        try {
            const ratings = await Rating.find({ ratee_id: req.session.user.id });
            if (ratings.length > 0) {
                const sum = ratings.reduce((acc, r) => acc + r.rating, 0);
                req.session.user.avg_rating = (sum / ratings.length).toFixed(1);
            } else {
                req.session.user.avg_rating = null;
            }
        } catch (err) {
            console.error('Error fetching user avg rating in middleware', err);
        }
    }
    res.locals.user = req.session.user || null;
    next();
});

// Routes
app.get('/', async (req, res) => {
    try {
        const userCount = await User.countDocuments();
        const matchCount = await Match.countDocuments();
        res.render('index', { 
            title: 'Khel Re - Find Your Team',
            userCount: userCount,
            matchCount: matchCount
        });
    } catch (err) {
        console.error(err);
        res.render('index', { 
            title: 'Khel Re - Find Your Team',
            userCount: 1200,
            matchCount: 340
        });
    }
});

// To be continued...
