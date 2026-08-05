const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { User, Match, Player, MatchPlayer, PlayerMatchStat } = require('./db');
const mongoose = require('mongoose');

// Middleware to check API authentication
const checkAuth = (req, res, next) => {
    if (req.session && req.session.user) {
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized' });
    }
};

// 1. Auth: Login
router.post('/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const user = await User.findOne({ email });
        if (!user) return res.status(401).json({ error: 'Invalid email or password' });

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(401).json({ error: 'Invalid email or password' });

        req.session.user = { id: user._id.toString(), name: user.name, email: user.email };
        res.json({ message: 'Login successful', user: req.session.user });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. Auth: Register
router.post('/register', async (req, res) => {
    const { name, email, password } = req.body;
    try {
        const existing = await User.findOne({ email });
        if (existing) return res.status(400).json({ error: 'Email already exists' });

        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = new User({ name, email, password: hashedPassword });
        await newUser.save();

        res.json({ message: 'Registration successful' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. Matches: Get all matches
router.get('/matches/:sport', async (req, res) => {
    try {
        const { sport } = req.params;
        const matches = await Match.aggregate([
            { $match: { sport: sport } },
            { $lookup: { from: 'users', localField: 'user_id', foreignField: '_id', as: 'host' } },
            { $unwind: { path: '$host', preserveNullAndEmptyArrays: true } },
            { $sort: { match_date: -1, match_time: -1 } },
            { $addFields: { host_name: '$host.name', id: '$_id' } }
        ]);
        res.json({ matches });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 4. Matches: Create match
router.post('/matches/:sport/create', checkAuth, async (req, res) => {
    try {
        const { sport } = req.params;
        const { team_name, match_date, match_time, players_needed, location, google_maps_link, overs } = req.body;
        
        const newMatch = new Match({
            user_id: req.session.user.id,
            sport,
            team_name,
            match_date,
            match_time,
            players_needed: parseInt(players_needed) || 0,
            location,
            google_maps_link,
            overs: parseInt(overs) || null,
            status: 'open',
            score: '0 - 0'
        });
        await newMatch.save();
        res.json({ message: 'Match created', match: newMatch });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 5. Matches: Join match
router.post('/matches/:id/join', checkAuth, async (req, res) => {
    try {
        const match = await Match.findById(req.params.id);
        if (!match) return res.status(404).json({ error: 'Match not found' });
        
        const existing = await MatchPlayer.findOne({ match_id: match._id, user_id: req.session.user.id });
        if (existing) return res.status(400).json({ error: 'Already joined' });

        if (match.players_needed > 0) {
            await new MatchPlayer({ match_id: match._id, user_id: req.session.user.id }).save();
            match.players_needed -= 1;
            await match.save();
            res.json({ message: 'Joined successfully' });
        } else {
            res.status(400).json({ error: 'Match full' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 6. Matches: Start match
router.post('/matches/:id/start', checkAuth, async (req, res) => {
    try {
        const match = await Match.findById(req.params.id);
        if (!match) return res.status(404).json({ error: 'Match not found' });
        if (match.user_id.toString() !== req.session.user.id) return res.status(403).json({ error: 'Not host' });
        
        match.status = 'started';
        await match.save();
        res.json({ message: 'Match started' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
